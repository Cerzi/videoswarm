const fs = require('fs');
const path = require('path');

const PARSER_VERSION = 1;
const DEFAULT_LIMITS = Object.freeze({
  concurrency: 2,
  maxPending: 64,
  timeoutMs: 5000,
  maxBytes: 2 * 1024 * 1024,
  maxDepth: 32,
  maxNodes: 10000,
  maxValuesPerField: 32,
  maxScalarLength: 1024,
  maxPromptLength: 16384,
});

class SidecarMetadataError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SidecarMetadataError';
    this.code = code;
  }
}

function getSidecarCandidatePaths(videoPath, pathImpl = path) {
  const absoluteVideoPath = pathImpl.resolve(videoPath);
  const directory = pathImpl.dirname(absoluteVideoPath);
  const extension = pathImpl.extname(absoluteVideoPath);
  const stem = pathImpl.basename(absoluteVideoPath, extension);
  return Array.from(new Set([
    `${absoluteVideoPath}.json`,
    pathImpl.join(directory, `${stem}.workflow.json`),
    pathImpl.join(directory, `${stem}.json`),
  ]));
}

async function findSidecarCandidate(
  videoPath,
  {
    fsPromises = fs.promises,
    pathImpl = path,
    maxBytes = DEFAULT_LIMITS.maxBytes,
    authorizePath = null,
  } = {}
) {
  const candidate = await openSidecarCandidate(videoPath, {
    fsPromises,
    pathImpl,
    maxBytes,
    authorizePath,
  });
  if (!candidate) return null;
  try {
    const { handle: _handle, ...description } = candidate;
    return description;
  } finally {
    await candidate.handle.close();
  }
}

async function openSidecarCandidate(
  videoPath,
  {
    fsPromises = fs.promises,
    pathImpl = path,
    maxBytes = DEFAULT_LIMITS.maxBytes,
    authorizePath = null,
  } = {}
) {
  for (const candidatePath of getSidecarCandidatePaths(videoPath, pathImpl)) {
    let handle = null;
    let stats;
    try {
      if (typeof fsPromises.lstat === 'function') {
        const linkStats = await fsPromises.lstat(candidatePath);
        if (linkStats?.isSymbolicLink?.()) {
          throw new SidecarMetadataError(
            'SIDECAR_SYMLINK_REJECTED',
            'Sidecar symbolic links are not allowed'
          );
        }
      }
      const noFollow = Number(fs.constants.O_NOFOLLOW || 0);
      handle = await fsPromises.open(
        candidatePath,
        Number(fs.constants.O_RDONLY || 0) | noFollow
      );
      if (typeof authorizePath === 'function') {
        await authorizePath(pathImpl.resolve(candidatePath));
      }
      stats = await handle.stat();
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
      }
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
      throw error;
    }
    if (!stats?.isFile?.()) {
      await handle.close();
      continue;
    }
    const size = Number(stats.size || 0);
    if (!Number.isFinite(size) || size < 0 || size > maxBytes) {
      await handle.close();
      throw new SidecarMetadataError(
        'SIDECAR_TOO_LARGE',
        `Sidecar exceeds the ${maxBytes}-byte limit`
      );
    }
    return {
      path: pathImpl.resolve(candidatePath),
      size,
      mtimeMs: Number(stats.mtimeMs || 0),
      handle,
    };
  }
  return null;
}

function normalizeKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function inspectJsonShape(root, limits = DEFAULT_LIMITS) {
  const stack = [{ value: root, depth: 0 }];
  let nodes = 0;
  const assertCanPushChild = (depth) => {
    if (depth > limits.maxDepth) {
      throw new SidecarMetadataError(
        'SIDECAR_DEPTH_LIMIT',
        `Sidecar exceeds the maximum depth of ${limits.maxDepth}`
      );
    }
    // Count pending nodes as part of the budget. Checking before reading and
    // pushing each child prevents a very wide JSON array/object from allocating
    // an enormous traversal stack before the next pop notices the limit.
    if (nodes + stack.length >= limits.maxNodes) {
      throw new SidecarMetadataError(
        'SIDECAR_NODE_LIMIT',
        `Sidecar exceeds the ${limits.maxNodes}-node limit`
      );
    }
  };

  while (stack.length) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > limits.maxNodes) {
      throw new SidecarMetadataError(
        'SIDECAR_NODE_LIMIT',
        `Sidecar exceeds the ${limits.maxNodes}-node limit`
      );
    }
    if (current.depth > limits.maxDepth) {
      throw new SidecarMetadataError(
        'SIDECAR_DEPTH_LIMIT',
        `Sidecar exceeds the maximum depth of ${limits.maxDepth}`
      );
    }
    if (!current.value || typeof current.value !== 'object') continue;
    const childDepth = current.depth + 1;
    if (Array.isArray(current.value)) {
      for (let index = 0; index < current.value.length; index += 1) {
        assertCanPushChild(childDepth);
        stack.push({ value: current.value[index], depth: childDepth });
      }
      continue;
    }
    for (const key in current.value) {
      if (!Object.prototype.hasOwnProperty.call(current.value, key)) continue;
      assertCanPushChild(childDepth);
      stack.push({ value: current.value[key], depth: childDepth });
    }
  }
}

async function readFileHandleBounded(
  handle,
  { maxBytes = DEFAULT_LIMITS.maxBytes, signal } = {}
) {
  const byteLimit = Math.max(0, Math.floor(Number(maxBytes) || 0));
  const buffer = Buffer.allocUnsafe(byteLimit + 1);
  let total = 0;
  while (total < buffer.length) {
    if (signal?.aborted) throw signal.reason;
    const { bytesRead } = await handle.read(
      buffer,
      total,
      buffer.length - total,
      total
    );
    if (signal?.aborted) throw signal.reason;
    if (!bytesRead) break;
    total += bytesRead;
  }
  if (total > byteLimit) {
    throw new SidecarMetadataError(
      'SIDECAR_TOO_LARGE',
      `Sidecar exceeds the ${byteLimit}-byte limit`
    );
  }
  return buffer.toString('utf8', 0, total);
}

function parseSidecarText(text, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options };
  const source = String(text ?? '');
  if (Buffer.byteLength(source, 'utf8') > limits.maxBytes) {
    throw new SidecarMetadataError(
      'SIDECAR_TOO_LARGE',
      `Sidecar exceeds the ${limits.maxBytes}-byte limit`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new SidecarMetadataError(
      'SIDECAR_INVALID_JSON',
      `Sidecar is not valid JSON: ${error?.message || error}`
    );
  }
  inspectJsonShape(parsed, limits);

  const buckets = {
    prompts: [],
    seeds: [],
    models: [],
    samplers: [],
    sourceImages: [],
    generationRuns: [],
  };
  const seen = Object.fromEntries(
    Object.keys(buckets).map((key) => [key, new Set()])
  );
  const add = (bucket, value, maxLength = limits.maxScalarLength, priority = 0) => {
    if (value === null || value === undefined) return;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return;
    }
    const normalized = String(value).trim().slice(0, maxLength);
    if (!normalized || seen[bucket].has(normalized)) return;
    if (buckets[bucket].length >= limits.maxValuesPerField) return;
    seen[bucket].add(normalized);
    buckets[bucket].push({ value: normalized, priority });
  };

  // JSON.parse cannot preserve integers beyond Number.MAX_SAFE_INTEGER. Capture
  // raw seed tokens first so large generation seeds remain exact strings.
  const unsafeSeedPattern = /"(?:seed|noise_seed|sampler_seed)"\s*:\s*(-?\d{16,})/gi;
  for (const match of source.matchAll(unsafeSeedPattern)) {
    add('seeds', match[1], limits.maxScalarLength, 10);
  }

  const promptKeys = new Map([
    ['positiveprompt', 5],
    ['prompttext', 5],
    ['prompt', 4],
    ['text', 1],
  ]);
  const seedKeys = new Set(['seed', 'noiseseed', 'samplerseed']);
  const modelKeys = new Set([
    'model', 'modelname', 'checkpoint', 'checkpointname', 'ckptname',
    'unetname', 'vae', 'vaename',
  ]);
  const samplerKeys = new Map([
    ['samplername', 5],
    ['sampler', 4],
    ['scheduler', 1],
  ]);
  const sourceImageKeys = new Set([
    'sourceimage', 'inputimage', 'initimage', 'startimage', 'image',
  ]);
  const generationRunKeys = new Set([
    'generationrun', 'runid', 'generationid', 'batchid', 'jobid',
  ]);

  const stack = [parsed];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push(value[index]);
      }
      continue;
    }
    const entries = Object.entries(value);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [rawKey, entryValue] = entries[index];
      const key = normalizeKey(rawKey);
      if (promptKeys.has(key)) {
        add('prompts', entryValue, limits.maxPromptLength, promptKeys.get(key));
      }
      if (seedKeys.has(key)) add('seeds', entryValue, limits.maxScalarLength, 2);
      if (modelKeys.has(key)) add('models', entryValue);
      if (samplerKeys.has(key)) {
        add('samplers', entryValue, limits.maxScalarLength, samplerKeys.get(key));
      }
      if (sourceImageKeys.has(key)) add('sourceImages', entryValue);
      if (generationRunKeys.has(key)) add('generationRuns', entryValue);
      if (entryValue && typeof entryValue === 'object') stack.push(entryValue);
    }
  }

  const values = (bucket) => buckets[bucket]
    .sort((left, right) => right.priority - left.priority)
    .map((entry) => entry.value);
  const prompts = values('prompts');
  const seeds = values('seeds');
  const models = values('models');
  const samplers = values('samplers');
  const sourceImages = values('sourceImages');
  const generationRuns = values('generationRuns');
  return {
    prompt: prompts[0] ?? null,
    seed: seeds[0] ?? null,
    model: models[0] ?? null,
    models,
    sampler: samplers[0] ?? null,
    samplers,
    sourceImage: sourceImages[0] ?? null,
    sourceImages,
    generationRun: generationRuns[0] ?? null,
  };
}

function createSidecarMetadataService(options = {}) {
  const fsPromises = options.fsPromises || fs.promises;
  const pathImpl = options.pathImpl || path;
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  const concurrency = Math.max(1, Math.min(2, Number(limits.concurrency) || 2));
  const maxPending = Math.max(1, Number(limits.maxPending) || 64);
  const queue = [];
  const active = new Set();
  const inFlight = new Map();
  let closed = false;

  const cancellationError = (code, message) =>
    new SidecarMetadataError(code, message);

  const processJob = async (job) => {
    const assertNotAborted = () => {
      if (job.controller.signal.aborted) {
        throw job.controller.signal.reason ||
          cancellationError('SIDECAR_CANCELLED', 'Sidecar parsing cancelled');
      }
    };
    job.assertActive?.();
    assertNotAborted();
    const instance = job.metadataStore.getFileInstanceById(job.instanceId);
    if (!instance?.absolutePath) {
      throw new SidecarMetadataError(
        'INSTANCE_NOT_FOUND',
        `File instance does not exist: ${job.instanceId}`
      );
    }
    const candidate = await openSidecarCandidate(instance.absolutePath, {
      fsPromises,
      pathImpl,
      maxBytes: limits.maxBytes,
      authorizePath: job.authorizePath,
    });
    if (!candidate) {
      job.assertActive?.();
      assertNotAborted();
      job.metadataStore.clearGenerationMetadata(job.instanceId);
      return { instanceId: job.instanceId, found: false, cached: false, metadata: null };
    }
    try {
      job.assertActive?.();
      assertNotAborted();
      const cached = job.metadataStore.getGenerationMetadata(job.instanceId);
      if (
        cached &&
        pathImpl.resolve(cached.sidecarPath) === candidate.path &&
        cached.sidecarSize === candidate.size &&
        cached.sidecarMtimeMs === candidate.mtimeMs &&
        cached.parserVersion === PARSER_VERSION
      ) {
        return { instanceId: job.instanceId, found: true, cached: true, metadata: cached };
      }

      const text = await readFileHandleBounded(candidate.handle, {
        maxBytes: limits.maxBytes,
        signal: job.controller.signal,
      });
      job.assertActive?.();
      assertNotAborted();
      const extracted = parseSidecarText(text, limits);
      job.assertActive?.();
      const metadata = job.metadataStore.setGenerationMetadata(job.instanceId, {
        ...extracted,
        sidecarPath: candidate.path,
        sidecarSize: Buffer.byteLength(text, 'utf8'),
        sidecarMtimeMs: candidate.mtimeMs,
        parserVersion: PARSER_VERSION,
      });
      return { instanceId: job.instanceId, found: true, cached: false, metadata };
    } finally {
      await candidate.handle.close().catch(() => {});
    }
  };

  const pump = () => {
    while (!closed && active.size < concurrency && queue.length) {
      const job = queue.shift();
      if (job.cancelled) continue;
      active.add(job);

      processJob(job)
        .then(job.resolve, (error) => {
          if (job.controller.signal.aborted) {
            job.reject(
              job.controller.signal.reason instanceof Error
                ? job.controller.signal.reason
                : cancellationError('SIDECAR_CANCELLED', 'Sidecar parsing cancelled')
            );
          } else {
            job.reject(error);
          }
        })
        .finally(() => {
          active.delete(job);
          pump();
        });
    }
  };

  const getMetadata = ({
    instanceId,
    ownerId = 'default',
    scopeId = ownerId,
    metadataStore,
    assertActive,
    authorizePath,
  }) => {
    if (closed) {
      return Promise.reject(
        cancellationError('SIDECAR_SHUTDOWN', 'Sidecar service is shut down')
      );
    }
    const normalizedInstanceId = Number(instanceId);
    if (!Number.isSafeInteger(normalizedInstanceId) || normalizedInstanceId <= 0) {
      return Promise.reject(new TypeError('A positive file instance id is required'));
    }
    if (!metadataStore?.getFileInstanceById) {
      return Promise.reject(new TypeError('A metadata store is required'));
    }
    if (authorizePath !== undefined && typeof authorizePath !== 'function') {
      return Promise.reject(new TypeError('authorizePath must be a function'));
    }
    const key = `${String(scopeId)}:${normalizedInstanceId}`;
    if (inFlight.has(key)) return inFlight.get(key);
    if (queue.length >= maxPending) {
      return Promise.reject(
        cancellationError('SIDECAR_QUEUE_FULL', 'Sidecar parsing queue is full')
      );
    }

    let resolveJob;
    let rejectJob;
    const basePromise = new Promise((resolve, reject) => {
      resolveJob = resolve;
      rejectJob = reject;
    });
    const job = {
      key,
      ownerId: String(ownerId),
      instanceId: normalizedInstanceId,
      metadataStore,
      assertActive,
      authorizePath,
      resolve(value) {
        if (job.settled) return false;
        job.settled = true;
        resolveJob(value);
        return true;
      },
      reject(error) {
        if (job.settled) return false;
        job.settled = true;
        rejectJob(error);
        return true;
      },
      controller: new AbortController(),
      timeout: null,
      cancelled: false,
      settled: false,
    };
    const promise = basePromise.finally(() => {
      clearTimeout(job.timeout);
      inFlight.delete(key);
    });
    inFlight.set(key, promise);
    queue.push(job);
    job.timeout = setTimeout(() => {
      const error = cancellationError(
        'SIDECAR_TIMEOUT',
        'Sidecar parsing timed out'
      );
      job.controller.abort(error);
      job.reject(error);
      if (!active.has(job)) {
        const queuedIndex = queue.indexOf(job);
        if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
        job.cancelled = true;
        pump();
      }
      // Active operations retain their bounded slot until the underlying OS
      // request returns, but their caller always settles at this deadline.
    }, Math.max(1, Number(limits.timeoutMs) || 5000));
    job.timeout.unref?.();
    pump();
    return promise;
  };

  const cancelOwner = (ownerId) => {
    const normalizedOwnerId = String(ownerId);
    let cancelled = 0;
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const job = queue[index];
      if (job.ownerId !== normalizedOwnerId) continue;
      queue.splice(index, 1);
      job.cancelled = true;
      job.reject(cancellationError('SIDECAR_CANCELLED', 'Sidecar parsing cancelled'));
      cancelled += 1;
    }
    active.forEach((job) => {
      if (job.ownerId !== normalizedOwnerId || job.controller.signal.aborted) return;
      const error = cancellationError(
        'SIDECAR_CANCELLED',
        'Sidecar parsing cancelled'
      );
      job.controller.abort(error);
      job.reject(error);
      cancelled += 1;
    });
    pump();
    return cancelled;
  };

  const cancelAll = () => {
    const owners = new Set([
      ...queue.map((job) => job.ownerId),
      ...Array.from(active, (job) => job.ownerId),
    ]);
    let cancelled = 0;
    owners.forEach((ownerId) => {
      cancelled += cancelOwner(ownerId);
    });
    return cancelled;
  };

  return {
    getMetadata,
    cancelOwner,
    cancelAll,
    shutdown() {
      closed = true;
      cancelAll();
    },
    getSnapshot: () => ({
      active: active.size,
      pending: queue.length,
      inFlight: inFlight.size,
      concurrency,
      maxPending,
      closed,
    }),
  };
}

module.exports = {
  PARSER_VERSION,
  DEFAULT_LIMITS,
  SidecarMetadataError,
  getSidecarCandidatePaths,
  findSidecarCandidate,
  inspectJsonShape,
  parseSidecarText,
  readFileHandleBounded,
  createSidecarMetadataService,
};
