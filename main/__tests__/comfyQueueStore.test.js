import { createRequire } from "module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createMemoryComfyQueueStore } = require("../comfy-queue-store");
const { describeComfyQueueStore } = require("./helpers/comfyQueueStoreContract.cjs");

let clock = 0;
describeComfyQueueStore({ describe, it, expect, beforeEach, afterEach }, "memory", () => ({
  store: createMemoryComfyQueueStore({ now: () => ++clock }),
}));
