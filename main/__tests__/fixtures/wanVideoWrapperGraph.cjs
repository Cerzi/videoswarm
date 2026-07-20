function createWanVideoWrapperGraph() {
  return {
    1: {
      class_type: 'LoadWanVideoT5TextEncoder',
      inputs: { model_name: 'fixture-t5.safetensors' },
    },
    2: {
      class_type: 'WanVideoTextEncode',
      inputs: {
        positive_prompt: ['3', 0],
        negative_prompt: 'fixture negative prompt',
        t5: ['1', 0],
      },
    },
    3: {
      class_type: 'PrimitiveStringMultiline',
      inputs: { value: 'fixture positive prompt' },
    },
    4: {
      class_type: 'WanVideoModelLoader',
      inputs: { model: 'fixture-high.safetensors', lora: ['29', 0] },
    },
    5: {
      class_type: 'WanVideoLoraSelect',
      inputs: { lora: 'fixture-high-base.safetensors', strength: 0.37 },
    },
    6: {
      class_type: 'WanVideoLoraSelectMulti',
      inputs: {
        prev_lora: ['5', 0],
        lora_0: 'fixture-high-detail.safetensors',
        strength_0: 0.72,
        lora_1: 'fixture-disabled.safetensors',
        strength_1: 0,
      },
    },
    7: { class_type: 'WanVideoSetBlockSwap', inputs: { model: ['4', 0] } },
    8: {
      class_type: 'WanVideoSetLoRAs',
      inputs: { model: ['7', 0], lora: ['6', 0] },
    },
    9: {
      class_type: 'WanVideoModelLoader',
      inputs: { model: 'fixture-low.safetensors' },
    },
    10: {
      class_type: 'WanVideoLoraSelect',
      inputs: { lora: 'fixture-low-base.safetensors', strength: 0.41 },
    },
    11: {
      class_type: 'WanVideoLoraSelectMulti',
      inputs: {
        prev_lora: ['10', 0],
        lora_0: 'fixture-low-detail.safetensors',
        strength_0: 0.63,
      },
    },
    12: { class_type: 'WanVideoSetBlockSwap', inputs: { model: ['9', 0] } },
    13: {
      class_type: 'WanVideoSetLoRAs',
      inputs: { model: ['12', 0], lora: ['11', 0] },
    },
    14: { class_type: 'INTConstant', inputs: { value: 11 } },
    15: { class_type: 'INTConstant', inputs: { value: 4 } },
    16: {
      class_type: 'Seed (rgthree)',
      inputs: { seed: '12345678901234567890' },
    },
    17: { class_type: 'LoadImage', inputs: { image: 'fixture-input.png' } },
    18: {
      class_type: 'FixtureImageEmbeds',
      inputs: { vae: ['21', 0], start_image: ['17', 0] },
    },
    19: {
      class_type: 'WanVideoSampler',
      inputs: {
        steps: ['14', 0],
        cfg: ['30', 0],
        seed: ['16', 0],
        scheduler: 'fixture-schedule',
        denoise_strength: 0.84,
        start_step: 0,
        end_step: ['15', 0],
        model: ['8', 0],
        image_embeds: ['18', 0],
        text_embeds: ['2', 0],
      },
    },
    20: {
      class_type: 'WanVideoSampler',
      inputs: {
        steps: ['14', 0],
        cfg: 1.35,
        seed: '424242424242',
        scheduler: 'fixture-schedule',
        denoise_strength: 0.84,
        start_step: ['15', 0],
        end_step: -1,
        model: ['13', 0],
        text_embeds: ['2', 0],
        samples: ['19', 0],
      },
    },
    21: {
      class_type: 'WanVideoVAELoader',
      inputs: { model_name: 'fixture-vae.safetensors' },
    },
    22: {
      class_type: 'WanVideoDecode',
      inputs: { samples: ['20', 0], vae: ['21', 0] },
    },
    23: { class_type: 'FixturePostProcess', inputs: { images: ['22', 0] } },
    24: {
      class_type: 'FixtureSwitch',
      inputs: { switch: false, on_false: ['23', 0], on_true: ['22', 0] },
    },
    25: {
      class_type: 'VHS_VideoCombine',
      inputs: { images: ['24', 0], filename_prefix: 'fixture-output' },
    },
    26: {
      class_type: 'WanVideoLoraSelect',
      inputs: { lora: 'fixture-disconnected-lora.safetensors', strength: 0.91 },
    },
    27: {
      class_type: 'WanVideoModelLoader',
      inputs: { model: 'fixture-disconnected-model.safetensors', lora: ['26', 0] },
    },
    28: {
      class_type: 'Note',
      inputs: { text: 'disconnected sentinel must never be extracted' },
    },
    29: {
      class_type: 'WanVideoLoraSelect',
      inputs: { lora: 'fixture-loader.safetensors', strength: 0.54 },
    },
    30: {
      class_type: 'CreateCFGScheduleFloatList',
      inputs: { steps: ['14', 0], cfg_scale_start: 2.3, cfg_scale_end: 1.7 },
    },
  };
}

module.exports = { createWanVideoWrapperGraph };
