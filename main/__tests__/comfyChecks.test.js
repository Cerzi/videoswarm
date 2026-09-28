import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { checkPrompt, classesToCheck, comboOptions } = require("../comfy-checks");

const info = {
  LoadImage: { input: { required: { image: [["ref-a.png", "ref-b.png", "sub/ref-c.png"]] } } },
  LoadVideo: { input: { required: { file: ["COMBO", { options: ["clip.mp4"] }] } } },
  LoraLoaderModelOnly: {
    input: { required: { model: ["MODEL"], lora_name: [["turbo.safetensors", "style.safetensors"]], strength_model: ["FLOAT"] } },
  },
  UNETLoader: { input: { required: { unet_name: [["base.safetensors"]] } } },
  "Power Lora Loader (rgthree)": { input: { required: {}, optional: { model: ["MODEL"] } } },
  Composer: { input: { required: { slot_filenames: ["STRING"] }, optional: { media: ["STRING"] } } },
  ImageList: { input: { required: { images: ["COMFY_AUTOGROW_V3", {}] } } },
  SaveVideo: { input: { required: { video: ["VIDEO"], filename_prefix: ["STRING"] } }, output_node: true },
};

function prompt(overrides = {}) {
  return {
    1: { class_type: "UNETLoader", inputs: { unet_name: "base.safetensors" } },
    2: {
      class_type: "Power Lora Loader (rgthree)",
      inputs: { model: ["1", 0], lora_1: { on: true, lora: "style.safetensors", strength: 1 }, lora_2: { on: false, lora: "gone.safetensors" } },
    },
    3: { class_type: "Composer", inputs: { slot_filenames: '["ref-a.png","sub/ref-c.png",""]', media: '{"videos":["clip.mp4",""]}', model: ["2", 0] } },
    4: { class_type: "ImageList", inputs: { "images.image_0": ["3", 0], "images.image_1": ["3", 0] } },
    5: { class_type: "SaveVideo", inputs: { video: ["4", 0], filename_prefix: "clips/a_final.png" } },
    // Not connected to an output: its inputs are never judged.
    9: { class_type: "Composer", inputs: { slot_filenames: '["missing.png"]' } },
    ...overrides,
  };
}

describe("checkPrompt", () => {
  it("passes a prompt everything is installed for", () => {
    const extra = prompt();
    extra[6] = { class_type: "LoraLoaderModelOnly", inputs: { lora_name: "turbo.safetensors", strength_model: 1, model: ["1", 0] } };
    expect(checkPrompt(extra, info)).toEqual([]);
  });

  it("names a missing node class, required input, model and LoRA", () => {
    const broken = prompt({
      1: { class_type: "UNETLoader", inputs: { unet_name: "gone-model.safetensors" } },
      2: { class_type: "Power Lora Loader (rgthree)", inputs: { model: ["1", 0], lora_1: { on: true, lora: "gone.safetensors" } } },
      4: { class_type: "ImageList", inputs: { other: ["3", 0] } },
      7: { class_type: "Not Installed Node", inputs: { images: ["4", 0] } },
    });
    broken[5].inputs.video = ["7", 0];
    expect(checkPrompt(broken, info).map((problem) => [problem.code, problem.message])).toEqual([
      ["COMFY_NODE_MISSING", "Not Installed Node is not installed in ComfyUI"],
      ["COMFY_OPTION_MISSING", "Missing model: gone-model.safetensors"],
      ["COMFY_OPTION_MISSING", "Missing LoRA: gone.safetensors"],
      ["COMFY_INPUT_MISSING", "ImageList needs 'images', which this render predates"],
    ]);
  });

  it("finds a missing reference file in a JSON list, without knowing the node", () => {
    const missing = prompt();
    missing[3].inputs.slot_filenames = '["ref-a.png","ref-gone.png"]';
    missing[3].inputs.media = '{"videos":["clip.mp4","gone.mp4"]}';
    expect(checkPrompt(missing, info).map((problem) => problem.message)).toEqual([
      "Composer slot_filenames names ref-gone.png, which is not in ComfyUI's input folder",
      "Composer media names gone.mp4, which is not in ComfyUI's input folder",
    ]);
  });

  it("ignores a missing file in a slot a sibling input switches off", () => {
    // As real MiniMax drafts carry them: a bypassed media slot names a file
    // that is no longer in the input folder, and renders fine.
    const offSlots = prompt();
    offSlots[3].inputs.slot_filenames = '["ref-a.png","ref-gone.png","ref-also-gone.png"]';
    offSlots[3].inputs.slot_bypassed = "[false,true,false]";
    offSlots[3].inputs.media = '{"videos":["gone.mp4","clip.mp4"]}';
    offSlots[3].inputs.media_settings = '{"videos":[{"mp":0.3,"bypassed":true},{"mp":0.4,"bypassed":false}]}';
    expect(checkPrompt(offSlots, info).map((problem) => problem.message)).toEqual([
      "Composer slot_filenames names ref-also-gone.png, which is not in ComfyUI's input folder",
    ]);
    // A list not named for bypassing does not switch anything off.
    offSlots[3].inputs.slot_bypassed = "[false,false,false]";
    offSlots[3].inputs.slot_enabled = "[true,true,true]";
    expect(checkPrompt(offSlots, info)).toHaveLength(2);
  });

  it("names a missing class anywhere in the prompt, as ComfyUI refuses it", () => {
    const orphan = prompt({ 8: { class_type: "Gone Saver", inputs: { video: ["4", 0] } } });
    expect(checkPrompt(orphan, info).map((problem) => problem.message)).toEqual([
      "Gone Saver is not installed in ComfyUI",
    ]);
  });

  it("does not check files when no loader lists the input folder, nor [output] files", () => {
    const withoutLoaders = { ...info };
    delete withoutLoaders.LoadImage;
    delete withoutLoaders.LoadVideo;
    const missing = prompt();
    missing[3].inputs.slot_filenames = '["ref-gone.png","x.png [output]"]';
    expect(checkPrompt(missing, withoutLoaders)).toEqual([]);
    missing[3].inputs.slot_filenames = '["ref-a.png","x.png [output]","ref-b.png [input]"]';
    expect(checkPrompt(missing, info)).toEqual([]);
  });

  it("lists the classes it needs, and reads both combo spellings", () => {
    expect(classesToCheck(prompt())).toEqual(
      expect.arrayContaining(["LoadImage", "LoadVideo", "LoadAudio", "LoraLoaderModelOnly", "Composer", "SaveVideo"])
    );
    expect(comboOptions([["a", "b"]])).toEqual(["a", "b"]);
    expect(comboOptions(["COMBO", { options: ["c"] }])).toEqual(["c"]);
    expect(comboOptions(["STRING"])).toBeNull();
    expect(checkPrompt(null, info)[0].code).toBe("COMFY_PROMPT_INVALID");
  });
});
