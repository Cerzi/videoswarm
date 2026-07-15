import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  quoteUnsafeJsonIntegers,
  parseComfyGenerationPayload,
} = require('../comfy-generation-parser');
const {
  createWanVideoWrapperGraph: wanVideoWrapperGraph,
} = require('./fixtures/wanVideoWrapperGraph.cjs');

function coreGraph({
  prefix = 'clip',
  positive = 'a fox running through snow',
  negative = 'blurry, distorted',
} = {}) {
  return {
    1: {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: 'wan2.2.safetensors' },
    },
    2: {
      class_type: 'LoraLoader',
      inputs: {
        model: ['1', 0],
        clip: ['1', 1],
        lora_name: 'cinematic-motion.safetensors',
        strength_model: 0.8,
        strength_clip: 0.65,
      },
    },
    3: {
      class_type: 'CLIPTextEncode',
      inputs: { text: positive, clip: ['2', 1] },
    },
    4: {
      class_type: 'CLIPTextEncode',
      inputs: { text: negative, clip: ['2', 1] },
    },
    5: {
      class_type: 'LoadImage',
      inputs: { image: 'start-frame.png' },
    },
    6: {
      class_type: 'ImageToLatent',
      inputs: { image: ['5', 0], vae: ['1', 2] },
    },
    7: {
      class_type: 'KSampler',
      inputs: {
        model: ['2', 0],
        positive: ['3', 0],
        negative: ['4', 0],
        latent_image: ['6', 0],
        seed: '900719925474099312345',
        steps: 24,
        cfg: 4.5,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: 0.9,
      },
    },
    8: {
      class_type: 'VAEDecode',
      inputs: { samples: ['7', 0], vae: ['1', 2] },
    },
    9: {
      class_type: 'VHS_VideoCombine',
      inputs: { images: ['8', 0], filename_prefix: prefix },
    },
  };
}

function wrapGraphWithRawSeed(graph) {
  return JSON.stringify({ prompt: JSON.stringify(graph) })
    .replace(
      '\\"seed\\":\\"900719925474099312345\\"',
      '\\"seed\\":900719925474099312345'
    );
}

function addBranch(graph, offset, prefix, prompt) {
  const id = (value) => String(offset + value);
  Object.assign(graph, {
    [id(1)]: {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: `${prefix}.safetensors` },
    },
    [id(2)]: {
      class_type: 'CLIPTextEncode',
      inputs: { text: prompt, clip: [id(1), 1] },
    },
    [id(3)]: {
      class_type: 'CLIPTextEncode',
      inputs: { text: `${prefix} negative`, clip: [id(1), 1] },
    },
    [id(4)]: {
      class_type: 'KSampler',
      inputs: {
        model: [id(1), 0],
        positive: [id(2), 0],
        negative: [id(3), 0],
        seed: offset,
        steps: 12,
        cfg: 3,
        sampler_name: 'euler',
        scheduler: 'simple',
      },
    },
    [id(5)]: {
      class_type: 'VAEDecode',
      inputs: { samples: [id(4), 0], vae: [id(1), 2] },
    },
    [id(6)]: {
      class_type: 'VHS_VideoCombine',
      inputs: { images: [id(5), 0], filename_prefix: prefix },
    },
  });
}

describe('ComfyUI generation graph parsing', () => {
  it('traces one VHS output to prompts, sampling, assets, LoRAs, and sources', () => {
    const result = parseComfyGenerationPayload(
      wrapGraphWithRawSeed(coreGraph()),
      {
        fileName: 'clip_00042.mp4',
        origin: { kind: 'embedded', carrier: 'isobmff' },
      }
    );

    expect(result).toMatchObject({
      provider: 'comfyui',
      origin: {
        kind: 'embedded',
        carrier: 'isobmff',
        metadataKey: 'prompt',
        graphFormat: 'api',
        resolution: 'traced',
      },
      output: {
        nodeId: '9',
        classType: 'VHS_VideoCombine',
        match: 'filename-prefix',
      },
      positivePrompt: 'a fox running through snow',
      negativePrompt: 'blurry, distorted',
      prompt: 'a fox running through snow',
      seed: '900719925474099312345',
      model: 'wan2.2.safetensors',
      sampler: 'euler',
      sourceImage: 'start-frame.png',
    });
    expect(result.samplerStages).toEqual([
      expect.objectContaining({
        nodeId: '7',
        role: 'final',
        seed: '900719925474099312345',
        steps: 24,
        cfg: 4.5,
        sampler: 'euler',
        scheduler: 'normal',
        denoise: 0.9,
      }),
    ]);
    expect(result.promptFragments).toEqual([
      expect.objectContaining({ role: 'positive', nodeId: '3', confidence: 'exact' }),
      expect.objectContaining({ role: 'negative', nodeId: '4', confidence: 'exact' }),
    ]);
    expect(result.assets).toMatchObject({
      models: [{ name: 'wan2.2.safetensors', kind: 'checkpoint', nodeId: '1' }],
      vaes: [{ name: 'wan2.2.safetensors', kind: 'bundled-checkpoint', nodeId: '1' }],
      textEncoders: [{
        name: 'wan2.2.safetensors',
        kind: 'bundled-checkpoint',
        nodeId: '1',
      }],
      loras: [{
        name: 'cinematic-motion.safetensors',
        nodeId: '2',
        strengthModel: 0.8,
        strengthClip: 0.65,
        appliedTo: ['clip', 'model'],
      }],
    });
    expect(result.sourceInputs).toEqual([
      { name: 'start-frame.png', kind: 'image', nodeId: '5', classType: 'LoadImage' },
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it('traces the bounded WanVideoWrapper API graph embedded by real outputs', () => {
    const result = parseComfyGenerationPayload({
      prompt: JSON.stringify(wanVideoWrapperGraph()),
      workflow: JSON.stringify({ nodes: [] }),
    }, {
      fileName: 'fixture-output_00001.mp4',
      origin: { kind: 'embedded', carrier: 'isobmff' },
    });

    expect(result).toMatchObject({
      origin: {
        kind: 'embedded',
        carrier: 'isobmff',
        metadataKey: 'prompt',
        graphFormat: 'api',
        resolution: 'traced',
      },
      output: {
        nodeId: '25',
        classType: 'VHS_VideoCombine',
        match: 'filename-prefix',
      },
      positivePrompt: 'fixture positive prompt',
      negativePrompt: 'fixture negative prompt',
      prompt: 'fixture positive prompt',
      seed: '424242424242',
      model: 'fixture-low.safetensors',
      sampler: 'WanVideoSampler',
      sourceImage: 'fixture-input.png',
    });
    expect(result.promptFragments).toEqual([
      expect.objectContaining({
        role: 'positive',
        nodeId: '3',
        field: 'value',
        confidence: 'exact',
      }),
      expect.objectContaining({
        role: 'negative',
        nodeId: '2',
        field: 'negative_prompt',
        confidence: 'exact',
      }),
    ]);
    expect(result.samplerStages).toEqual([
      expect.objectContaining({
        nodeId: '19',
        role: 'contributor',
        seed: '12345678901234567890',
        steps: 11,
        cfg: null,
        sampler: 'WanVideoSampler',
        scheduler: 'fixture-schedule',
        denoise: 0.84,
        startStep: 0,
        endStep: 4,
      }),
      expect.objectContaining({
        nodeId: '20',
        role: 'final',
        seed: '424242424242',
        steps: 11,
        cfg: 1.35,
        denoise: 0.84,
        startStep: 4,
        endStep: -1,
      }),
    ]);
    expect(result.assets.models.map(({ name }) => name)).toEqual([
      'fixture-low.safetensors',
      'fixture-high.safetensors',
    ]);
    expect(result.assets.vaes).toEqual([
      expect.objectContaining({ name: 'fixture-vae.safetensors', nodeId: '21' }),
    ]);
    expect(result.assets.textEncoders).toEqual([
      expect.objectContaining({ name: 'fixture-t5.safetensors', nodeId: '1' }),
    ]);
    expect(result.assets.loras).toEqual([
      {
        name: 'fixture-low-base.safetensors',
        nodeId: '10',
        strengthModel: 0.41,
        strengthClip: null,
        appliedTo: ['model'],
      },
      {
        name: 'fixture-low-detail.safetensors',
        nodeId: '11',
        strengthModel: 0.63,
        strengthClip: null,
        appliedTo: ['model'],
      },
      {
        name: 'fixture-high-base.safetensors',
        nodeId: '5',
        strengthModel: 0.37,
        strengthClip: null,
        appliedTo: ['model'],
      },
      {
        name: 'fixture-high-detail.safetensors',
        nodeId: '6',
        strengthModel: 0.72,
        strengthClip: null,
        appliedTo: ['model'],
      },
      {
        name: 'fixture-loader.safetensors',
        nodeId: '29',
        strengthModel: 0.54,
        strengthClip: null,
        appliedTo: ['model'],
      },
    ]);
    expect(result.sourceInputs).toEqual([
      { name: 'fixture-input.png', kind: 'image', nodeId: '17', classType: 'LoadImage' },
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('disconnected sentinel');
    expect(JSON.stringify(result)).not.toContain('fixture-disabled');
    expect(JSON.stringify(result)).not.toContain('fixture-disconnected');
  });

  it('does not guess a Wan prompt from an unregistered runtime string node', () => {
    const graph = wanVideoWrapperGraph();
    graph[3] = {
      class_type: 'UnknownPromptBuilder',
      inputs: { value: 'tempting but not proven runtime text' },
    };

    const result = parseComfyGenerationPayload(graph, {
      fileName: 'fixture-output_00001.mp4',
    });

    expect(result.positivePrompt).toBeNull();
    expect(result.negativePrompt).toBe('fixture negative prompt');
    expect(result.origin.resolution).toBe('partial');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'UNRESOLVED_DYNAMIC_PROMPT',
      nodeId: '2',
      role: 'positive',
    }));
    expect(JSON.stringify(result)).not.toContain('tempting but not proven');
  });

  it('resolves the core SamplerCustom helper graph', () => {
    const graph = {
      1: {
        class_type: 'CheckpointLoaderSimple',
        inputs: { ckpt_name: 'model.safetensors' },
      },
      2: {
        class_type: 'CLIPTextEncode',
        inputs: { text: 'positive', clip: ['1', 1] },
      },
      3: {
        class_type: 'CLIPTextEncode',
        inputs: { text: 'negative', clip: ['1', 1] },
      },
      4: { class_type: 'RandomNoise', inputs: { noise_seed: '18446744073709551615' } },
      5: {
        class_type: 'CFGGuider',
        inputs: {
          model: ['1', 0],
          positive: ['2', 0],
          negative: ['3', 0],
          cfg: 5.25,
        },
      },
      6: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'dpmpp_2m' } },
      7: {
        class_type: 'BasicScheduler',
        inputs: { model: ['1', 0], scheduler: 'karras', steps: 30, denoise: 0.75 },
      },
      8: {
        class_type: 'SamplerCustom',
        inputs: {
          noise: ['4', 0],
          guider: ['5', 0],
          sampler: ['6', 0],
          sigmas: ['7', 0],
        },
      },
      9: {
        class_type: 'VAEDecode',
        inputs: { samples: ['8', 0], vae: ['1', 2] },
      },
      10: {
        class_type: 'VHS_VideoCombine',
        inputs: { images: ['9', 0], filename_prefix: 'custom' },
      },
    };

    const result = parseComfyGenerationPayload(graph, {
      fileName: 'custom_00001.webm',
    });

    expect(result.samplerStages).toEqual([
      expect.objectContaining({
        nodeId: '8',
        seed: '18446744073709551615',
        steps: 30,
        cfg: 5.25,
        sampler: 'dpmpp_2m',
        scheduler: 'karras',
        denoise: 0.75,
      }),
    ]);
    expect(result).toMatchObject({
      positivePrompt: 'positive',
      negativePrompt: 'negative',
      seed: '18446744073709551615',
      sampler: 'dpmpp_2m',
      samplers: ['dpmpp_2m', 'karras'],
    });
  });

  it('preserves conditioning fragments instead of inventing one concatenated prompt', () => {
    const graph = coreGraph({ positive: 'unused direct prompt' });
    graph[10] = {
      class_type: 'CLIPTextEncode',
      inputs: { text: 'first positive fragment', clip: ['2', 1] },
    };
    graph[11] = {
      class_type: 'CLIPTextEncode',
      inputs: { text: 'second positive fragment', clip: ['2', 1] },
    };
    graph[12] = {
      class_type: 'ConditioningCombine',
      inputs: { conditioning_1: ['10', 0], conditioning_2: ['11', 0] },
    };
    graph[7].inputs.positive = ['12', 0];
    graph[13] = {
      class_type: 'Note',
      inputs: { text: 'this note must never become a prompt' },
    };

    const result = parseComfyGenerationPayload(graph, { fileName: 'clip_1.mp4' });

    expect(result.positivePrompt).toBeNull();
    expect(result.prompt).toBeNull();
    expect(result.promptFragments.filter(({ role }) => role === 'positive')).toEqual([
      expect.objectContaining({
        text: 'first positive fragment',
        composition: 'conditioning-combine',
      }),
      expect.objectContaining({
        text: 'second positive fragment',
        composition: 'conditioning-combine',
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain('this note must never become a prompt');
    expect(result.origin.resolution).toBe('partial');
  });

  it('does not guess values produced by unknown runtime prompt nodes', () => {
    const graph = coreGraph();
    graph[14] = {
      class_type: 'CustomPromptAssembler',
      inputs: {
        text: 'tempting but not necessarily the executed result',
        delimiter: ', ',
      },
    };
    graph[3].inputs.text = ['14', 0];

    const result = parseComfyGenerationPayload(graph, { fileName: 'clip_1.mp4' });

    expect(result.positivePrompt).toBeNull();
    expect(result.promptFragments).toEqual([
      expect.objectContaining({ role: 'negative', text: 'blurry, distorted' }),
    ]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'UNRESOLVED_DYNAMIC_PROMPT',
      nodeId: '3',
      role: 'positive',
    }));
    expect(JSON.stringify(result)).not.toContain('tempting but not necessarily');
    expect(result.origin.resolution).toBe('partial');
  });

  it('marks an overlong prompt partial when clamping it to the prompt limit', () => {
    const graph = coreGraph({ positive: 'x'.repeat(16_385) });

    const result = parseComfyGenerationPayload(graph, { fileName: 'clip_1.mp4' });

    expect(result.positivePrompt).toHaveLength(16_384);
    expect(result.origin.resolution).toBe('partial');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'PROMPT_FRAGMENT_TRUNCATED',
      nodeId: '3',
      role: 'positive',
    }));
  });

  it('selects one filename-owned output without merging another branch', () => {
    const graph = {};
    addBranch(graph, 0, 'alpha', 'alpha prompt');
    addBranch(graph, 100, 'beta', 'beta prompt');

    const result = parseComfyGenerationPayload(graph, {
      fileName: 'beta_00017.mp4',
    });

    expect(result.output).toEqual({
      nodeId: '106',
      classType: 'VHS_VideoCombine',
      match: 'filename-prefix',
    });
    expect(result.positivePrompt).toBe('beta prompt');
    expect(result.models).toEqual(['beta.safetensors']);
    expect(JSON.stringify(result)).not.toContain('alpha prompt');
    expect(JSON.stringify(result)).not.toContain('alpha.safetensors');
  });

  it('reports unmatched multiple outputs as ambiguous and returns no merged facts', () => {
    const graph = {};
    addBranch(graph, 0, 'alpha', 'alpha prompt');
    addBranch(graph, 100, 'beta', 'beta prompt');

    const result = parseComfyGenerationPayload(graph, {
      fileName: 'unrelated.mp4',
    });

    expect(result).toMatchObject({
      origin: { resolution: 'ambiguous' },
      output: null,
      prompt: null,
      models: [],
      samplerStages: [],
      diagnostics: [{ code: 'AMBIGUOUS_OUTPUT' }],
    });
  });

  it('orders serial base and final sampler stages by their output dependency', () => {
    const graph = coreGraph({ positive: 'shared positive' });
    graph[20] = {
      class_type: 'KSamplerAdvanced',
      inputs: {
        model: ['2', 0],
        positive: ['3', 0],
        negative: ['4', 0],
        latent_image: ['7', 0],
        noise_seed: 222,
        steps: 8,
        cfg: 2.5,
        sampler_name: 'dpmpp_sde',
        scheduler: 'karras',
        start_at_step: 4,
        end_at_step: 8,
      },
    };
    graph[8].inputs.samples = ['20', 0];

    const result = parseComfyGenerationPayload(graph, { fileName: 'clip_1.mp4' });

    expect(result.samplerStages.map(({ nodeId, role }) => ({ nodeId, role }))).toEqual([
      { nodeId: '7', role: 'contributor' },
      { nodeId: '20', role: 'final' },
    ]);
    expect(result.seed).toBe('222');
    expect(result.sampler).toBe('dpmpp_sde');
    expect(result.positivePrompt).toBe('shared positive');
  });

  it('unwraps legacy double-stringified API graphs and ignores plain prompt strings', () => {
    const graph = coreGraph();
    const legacy = { prompt: JSON.stringify(JSON.stringify(graph)) };

    expect(parseComfyGenerationPayload(legacy, { fileName: 'clip_1.mp4' }))
      .toMatchObject({ positivePrompt: 'a fox running through snow' });
    expect(parseComfyGenerationPayload({ prompt: 'a plain human prompt' })).toBeNull();
  });

  it('lets a valid generic sidecar with a plain prompt fall through', () => {
    expect(parseComfyGenerationPayload(JSON.stringify({
      prompt: 'a generic sidecar prompt',
      seed: 0,
    }))).toBeNull();
  });

  it('quotes only unsafe JSON integer tokens and enforces graph/traversal bounds', () => {
    const source = '{"seed":18446744073709551615,"text":"18446744073709551615"}';
    expect(quoteUnsafeJsonIntegers(source)).toBe(
      '{"seed":"18446744073709551615","text":"18446744073709551615"}'
    );

    expect(() => parseComfyGenerationPayload(coreGraph(), {
      limits: { maxGraphNodes: 2 },
    })).toThrowError(expect.objectContaining({ code: 'COMFY_GRAPH_NODE_LIMIT' }));
    expect(() => parseComfyGenerationPayload(coreGraph(), {
      limits: { maxTraversalDepth: 2 },
    })).toThrowError(expect.objectContaining({ code: 'COMFY_TRAVERSAL_DEPTH_LIMIT' }));

    const wide = [];
    wide.length = 100_000;
    Object.defineProperty(wide, 0, {
      enumerable: true,
      get() {
        throw new Error('wide child was read after the JSON budget was exhausted');
      },
    });
    expect(() => parseComfyGenerationPayload({ prompt: wide }, {
      limits: { maxJsonNodes: 1 },
    })).toThrowError(expect.objectContaining({ code: 'COMFY_JSON_NODE_LIMIT' }));
  });
});
