import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  PARSER_VERSION,
  getSidecarCandidatePaths,
  findSidecarCandidate,
  inspectJsonShape,
  parseSidecarText,
  createSidecarMetadataService,
} = require('../sidecar-metadata');

describe('sidecar metadata parsing', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videoswarm-sidecar-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses only the three adjacent candidates in deterministic priority order', async () => {
    const videoPath = path.join(tempDir, 'clip.mp4');
    fs.writeFileSync(videoPath, 'video');
    const candidates = getSidecarCandidatePaths(videoPath);
    expect(candidates).toEqual([
      `${videoPath}.json`,
      path.join(tempDir, 'clip.workflow.json'),
      path.join(tempDir, 'clip.json'),
    ]);
    candidates.forEach((candidate, index) => {
      fs.writeFileSync(candidate, JSON.stringify({ prompt: `candidate ${index}` }));
    });
    expect((await findSidecarCandidate(videoPath)).path).toBe(candidates[0]);
    fs.rmSync(candidates[0]);
    expect((await findSidecarCandidate(videoPath)).path).toBe(candidates[1]);
    expect(getSidecarCandidatePaths(videoPath)).not.toContain(
      path.join(tempDir, 'workflow.json')
    );
  });

  it('extracts bounded generic and graph fields without retaining workflow JSON', () => {
    const text = `{
      "prompt": "a red fox running",
      "run_id": "wan-run-7",
      "nodes": {
        "1": {"inputs": {
          "seed": 900719925474099312345,
          "sampler_name": "euler",
          "scheduler": "normal"
        }},
        "2": {"inputs": {"ckpt_name": "wan2.2.safetensors"}},
        "3": {"inputs": {"image": "source.png"}}
      }
    }`;
    const result = parseSidecarText(text);
    expect(result).toMatchObject({
      prompt: 'a red fox running',
      seed: '900719925474099312345',
      model: 'wan2.2.safetensors',
      sampler: 'euler',
      sourceImage: 'source.png',
      generationRun: 'wan-run-7',
    });
    expect(result.samplers).toEqual(['euler', 'normal']);
    expect(result).not.toHaveProperty('nodes');
  });

  it('does not guess that an arbitrary nested text field is the prompt', () => {
    const result = parseSidecarText(JSON.stringify({
      workflow: {
        nodes: [
          { type: 'Note', inputs: { text: 'documentation, not a prompt' } },
        ],
      },
    }));
    expect(result.prompt).toBeNull();
  });

  it('rejects malformed, oversized, too-deep, and high-node JSON', () => {
    expect(() => parseSidecarText('{')).toThrowError(
      expect.objectContaining({ code: 'SIDECAR_INVALID_JSON' })
    );
    expect(() => parseSidecarText(JSON.stringify({ prompt: 'x'.repeat(100) }), {
      maxBytes: 20,
    })).toThrowError(expect.objectContaining({ code: 'SIDECAR_TOO_LARGE' }));

    let nested = { value: true };
    for (let index = 0; index < 34; index += 1) nested = { nested };
    expect(() => parseSidecarText(JSON.stringify(nested))).toThrowError(
      expect.objectContaining({ code: 'SIDECAR_DEPTH_LIMIT' })
    );
    expect(() => parseSidecarText(JSON.stringify(Array.from({ length: 20 }, (_, i) => i)), {
      maxNodes: 10,
    })).toThrowError(expect.objectContaining({ code: 'SIDECAR_NODE_LIMIT' }));
  });

  it('enforces the node budget before reading or stacking wide children', () => {
    const wide = [];
    wide.length = 100_000;
    Object.defineProperty(wide, 0, {
      enumerable: true,
      get() {
        throw new Error('child was read after the node budget was exhausted');
      },
    });

    expect(() => inspectJsonShape(wide, { maxDepth: 32, maxNodes: 1 }))
      .toThrowError(expect.objectContaining({ code: 'SIDECAR_NODE_LIMIT' }));
  });

  it('rejects the highest-priority existing candidate when it exceeds 2 MiB', async () => {
    const videoPath = path.join(tempDir, 'large.mp4');
    fs.writeFileSync(videoPath, 'video');
    fs.writeFileSync(`${videoPath}.json`, Buffer.alloc(2 * 1024 * 1024 + 1));
    fs.writeFileSync(path.join(tempDir, 'large.json'), '{}');
    await expect(findSidecarCandidate(videoPath)).rejects.toMatchObject({
      code: 'SIDECAR_TOO_LARGE',
    });
  });
});

function createFakeStore(instances) {
  const metadata = new Map();
  return {
    getFileInstanceById: vi.fn((id) => instances.get(id) || null),
    getGenerationMetadata: vi.fn((id) => metadata.get(id) || null),
    setGenerationMetadata: vi.fn((id, value) => {
      const stored = {
        instanceId: id,
        ...value,
        model: value.models?.[0] ?? null,
        sampler: value.samplers?.[0] ?? null,
        sourceImage: value.sourceImages?.[0] ?? null,
      };
      metadata.set(id, stored);
      return stored;
    }),
    clearGenerationMetadata: vi.fn((id) => metadata.delete(id)),
  };
}

describe('bounded sidecar metadata service', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videoswarm-sidecar-service-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function addInstance(instances, id, prompt) {
    const videoPath = path.join(tempDir, `${id}.mp4`);
    fs.writeFileSync(videoPath, 'video');
    fs.writeFileSync(`${videoPath}.json`, JSON.stringify({ prompt, seed: id }));
    instances.set(id, { id, absolutePath: videoPath });
  }

  it('deduplicates each instance, caps concurrency at two, and reuses signatures', async () => {
    const instances = new Map();
    addInstance(instances, 1, 'one');
    addInstance(instances, 2, 'two');
    addInstance(instances, 3, 'three');
    const store = createFakeStore(instances);
    let activeReads = 0;
    let maximumReads = 0;
    let readCount = 0;
    const fsPromises = {
      open: async (...args) => {
        const handle = await fs.promises.open(...args);
        let countedRead = false;
        return {
          stat: (...statArgs) => handle.stat(...statArgs),
          read: async (...readArgs) => {
            const firstRead = !countedRead;
            if (firstRead) {
              countedRead = true;
              readCount += 1;
              activeReads += 1;
              maximumReads = Math.max(maximumReads, activeReads);
              await new Promise((resolve) => setTimeout(resolve, 15));
            }
            try {
              return await handle.read(...readArgs);
            } finally {
              if (firstRead) activeReads -= 1;
            }
          },
          close: () => handle.close(),
        };
      },
    };
    const service = createSidecarMetadataService({ fsPromises });
    const request = (instanceId) => service.getMetadata({
      instanceId,
      ownerId: 'window-1',
      scopeId: 'profile-1',
      metadataStore: store,
    });

    const first = request(1);
    const duplicate = request(1);
    expect(duplicate).toBe(first);
    const results = await Promise.all([first, duplicate, request(2), request(3)]);
    expect(maximumReads).toBe(2);
    expect(store.setGenerationMetadata).toHaveBeenCalledTimes(3);
    expect(results[0]).toMatchObject({ found: true, cached: false });

    const cached = await request(1);
    expect(cached).toMatchObject({ found: true, cached: true });
    expect(readCount).toBe(3);
    expect(cached.metadata.parserVersion).toBe(PARSER_VERSION);

    fs.writeFileSync(
      `${instances.get(1).absolutePath}.json`,
      JSON.stringify({ prompt: 'one changed and longer', seed: 101 })
    );
    const refreshed = await request(1);
    expect(refreshed).toMatchObject({
      found: true,
      cached: false,
      metadata: { prompt: 'one changed and longer' },
    });
    expect(readCount).toBe(4);
    service.shutdown();
  });

  it('clears stale cached metadata when no adjacent candidate remains', async () => {
    const instances = new Map();
    addInstance(instances, 1, 'one');
    const store = createFakeStore(instances);
    const service = createSidecarMetadataService();
    await service.getMetadata({ instanceId: 1, metadataStore: store });
    fs.rmSync(`${instances.get(1).absolutePath}.json`);

    await expect(
      service.getMetadata({ instanceId: 1, metadataStore: store })
    ).resolves.toMatchObject({ found: false, metadata: null });
    expect(store.clearGenerationMetadata).toHaveBeenCalledWith(1);
    service.shutdown();
  });

  it('authorizes the concrete sidecar before reading or caching it', async () => {
    const instances = new Map();
    addInstance(instances, 1, 'one');
    const store = createFakeStore(instances);
    const denial = Object.assign(new Error('outside granted root'), {
      code: 'PATH_NOT_AUTHORIZED',
    });
    const authorizePath = vi.fn(async () => {
      throw denial;
    });
    const service = createSidecarMetadataService();

    await expect(service.getMetadata({
      instanceId: 1,
      metadataStore: store,
      authorizePath,
    })).rejects.toBe(denial);
    expect(authorizePath).toHaveBeenCalledWith(
      path.resolve(`${instances.get(1).absolutePath}.json`)
    );
    expect(store.setGenerationMetadata).not.toHaveBeenCalled();
    service.shutdown();
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a sidecar symlink before opening its target',
    async () => {
      const instances = new Map();
      addInstance(instances, 1, 'one');
      const sidecarPath = `${instances.get(1).absolutePath}.json`;
      const outsidePath = path.join(tempDir, 'outside.json');
      fs.writeFileSync(outsidePath, JSON.stringify({ prompt: 'outside' }));
      fs.rmSync(sidecarPath);
      fs.symlinkSync(outsidePath, sidecarPath);
      const store = createFakeStore(instances);
      const service = createSidecarMetadataService();

      await expect(service.getMetadata({
        instanceId: 1,
        metadataStore: store,
        authorizePath: vi.fn(),
      })).rejects.toMatchObject({ code: 'SIDECAR_SYMLINK_REJECTED' });
      expect(store.setGenerationMetadata).not.toHaveBeenCalled();
      service.shutdown();
    }
  );

  it('times out and cancels owned work without allowing an unbounded queue', async () => {
    const instances = new Map();
    addInstance(instances, 1, 'one');
    addInstance(instances, 2, 'two');
    const store = createFakeStore(instances);
    let releaseRead = null;
    const handle = {
      stat: vi.fn(async () => ({
        isFile: () => true,
        size: 2,
        mtimeMs: 1,
      })),
      read: vi.fn(() => new Promise((resolve) => {
        releaseRead = () => resolve({ bytesRead: 0 });
      })),
      close: vi.fn(async () => {}),
    };
    const fsPromises = { open: vi.fn(async () => handle) };
    const service = createSidecarMetadataService({
      fsPromises,
      limits: { concurrency: 1, maxPending: 1, timeoutMs: 10 },
    });
    const active = service.getMetadata({
      instanceId: 1,
      ownerId: 'owner-a',
      metadataStore: store,
    });
    const activeError = active.catch((error) => error);
    const queued = service.getMetadata({
      instanceId: 2,
      ownerId: 'owner-b',
      metadataStore: store,
    });
    await expect(service.getMetadata({
      instanceId: 3,
      ownerId: 'owner-c',
      metadataStore: store,
    })).rejects.toMatchObject({ code: 'SIDECAR_QUEUE_FULL' });

    service.cancelOwner('owner-b');
    await expect(queued).rejects.toMatchObject({ code: 'SIDECAR_CANCELLED' });
    await vi.waitFor(() => expect(releaseRead).toBeTypeOf('function'));
    await expect(activeError).resolves.toMatchObject({ code: 'SIDECAR_TIMEOUT' });
    expect(service.getSnapshot()).toMatchObject({ active: 1, pending: 0, inFlight: 0 });
    releaseRead();
    await vi.waitFor(() => {
      expect(service.getSnapshot()).toMatchObject({ active: 0, pending: 0 });
    });
    service.shutdown();
  });

  it('settles the timeout while an unabortable candidate stat remains hung', async () => {
    const instances = new Map([
      [1, { id: 1, absolutePath: path.join(tempDir, 'hung.mp4') }],
      [2, { id: 2, absolutePath: path.join(tempDir, 'queued.mp4') }],
    ]);
    const store = createFakeStore(instances);
    let releaseStat;
    const handle = {
      stat: () => new Promise((resolve) => {
        releaseStat = resolve;
      }),
      read: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const service = createSidecarMetadataService({
      fsPromises: { open: vi.fn(async () => handle) },
      limits: { concurrency: 1, timeoutMs: 10 },
    });

    const request = service.getMetadata({ instanceId: 1, metadataStore: store });
    const requestError = request.catch((error) => error);
    const queuedRequest = service.getMetadata({ instanceId: 2, metadataStore: store });
    const queuedError = queuedRequest.catch((error) => error);
    await vi.waitFor(() => expect(releaseStat).toBeTypeOf('function'));
    await expect(requestError).resolves.toMatchObject({ code: 'SIDECAR_TIMEOUT' });
    await expect(queuedError).resolves.toMatchObject({ code: 'SIDECAR_TIMEOUT' });
    expect(service.getSnapshot()).toMatchObject({ active: 1, pending: 0, inFlight: 0 });

    releaseStat({ isFile: () => true, size: 2, mtimeMs: 1 });
    await vi.waitFor(() => {
      expect(service.getSnapshot()).toMatchObject({ active: 0, inFlight: 0 });
    });
    expect(handle.read).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledOnce();
    service.shutdown();
  });

  it('reads maxBytes plus one from the opened candidate handle and closes it', async () => {
    const instances = new Map([[1, {
      id: 1,
      absolutePath: path.join(tempDir, 'growing.mp4'),
    }]]);
    const store = createFakeStore(instances);
    const handle = {
      stat: vi.fn(async () => ({ isFile: () => true, size: 2, mtimeMs: 1 })),
      read: vi.fn(async (buffer, offset, length) => {
        buffer.fill(0x61, offset, offset + length);
        return { bytesRead: length, buffer };
      }),
      close: vi.fn(async () => {}),
    };
    const fsPromises = { open: vi.fn(async () => handle) };
    const service = createSidecarMetadataService({
      fsPromises,
      limits: { maxBytes: 16 },
    });

    await expect(
      service.getMetadata({ instanceId: 1, metadataStore: store })
    ).rejects.toMatchObject({ code: 'SIDECAR_TOO_LARGE' });
    expect(fsPromises.open).toHaveBeenCalledOnce();
    expect(handle.read).toHaveBeenCalledWith(
      expect.objectContaining({ length: 17 }),
      0,
      17,
      0
    );
    expect(handle.close).toHaveBeenCalledOnce();
    service.shutdown();
  });
});
