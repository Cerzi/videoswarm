// The queue store's contract, run against the in-memory store under Node and
// against the profile's SQLite store under Electron's ABI.
function describeComfyQueueStore({ describe, it, expect, beforeEach, afterEach }, name, makeStore) {
  describe(`comfy queue store: ${name}`, () => {
    let context;
    let store;
    beforeEach(() => {
      context = makeStore();
      store = context.store;
    });
    afterEach(() => context.dispose?.());

    it("saves, lists and deletes recipes with exact 64-bit values", () => {
      const recipe = { kind: "videoswarm.comfy-recipe", version: 1, learnedFrom: ["a", "b"], ops: [{ id: "set:1:seed", status: "varies", to: 18446744073709551615n }] };
      const saved = store.saveRecipe({ name: "Omni quality", recipe });
      expect(saved).toMatchObject({ name: "Omni quality", learnedFrom: ["a", "b"], operations: 1, varies: 1 });
      expect(store.getRecipe(saved.id).recipe.ops[0].to).toBe(18446744073709551615n);
      expect(store.listRecipes().map((entry) => entry.name)).toEqual(["Omni quality"]);
      expect(store.deleteRecipe(saved.id)).toBe(true);
      expect(store.getRecipe(saved.id)).toBeNull();
    });

    it("keeps queue items in added order and updates their state", () => {
      const knobs = { choices: { b: { keep: true } }, settings: { "set:3:value": 50 } };
      const first = store.addQueueItem({ fingerprint: "fp-1", draftPath: "/out/a_00001_.mp4", recipeId: 1, knobs, addedAt: 10 });
      store.addQueueItem({ fingerprint: "fp-2", draftPath: "/out/b_00001_.mp4", recipeId: 1, knobs: {}, addedAt: 20 });
      expect(first).toMatchObject({ state: "ready", attempts: 0, promptId: null, renderAgain: false });
      expect(store.listQueueItems().map((item) => item.fingerprint)).toEqual(["fp-1", "fp-2"]);
      const updated = store.updateQueueItem(first.id, { state: "waiting", promptId: "p1", attempts: 1, renderAgain: true, ignored: 1 });
      expect(updated).toMatchObject({ state: "waiting", promptId: "p1", attempts: 1, renderAgain: true });
      expect(() => store.updateQueueItem(first.id, { state: "exploded" })).toThrow(/Unknown queue state/);
      // The same knobs in another key order are the same queue entry.
      const reordered = { settings: { "set:3:value": 50 }, choices: { b: { keep: true } } };
      expect(store.findActiveQueueItem({ fingerprint: "fp-1", recipeId: 1, knobs: reordered })?.id).toBe(first.id);
      store.updateQueueItem(first.id, { state: "done" });
      expect(store.findActiveQueueItem({ fingerprint: "fp-1", recipeId: 1, knobs: reordered })).toBeNull();
      expect(store.removeQueueItem(first.id)).toBe(true);
      expect(store.getQueueItem(first.id)).toBeNull();
    });

    it("keeps the holds a person confirmed, cleaned, and outside the knobs", () => {
      const item = store.addQueueItem({ fingerprint: "fp-1", draftPath: "/out/a_00001_.mp4", recipeId: 1, knobs: {} });
      expect(item.confirmed).toEqual([]);
      const updated = store.updateQueueItem(item.id, {
        confirmed: ["save:9:CustomSave", "save:9:CustomSave", 5, "", "x".repeat(300), "dependency:4:Editor"],
      });
      expect(updated.confirmed).toEqual(["save:9:CustomSave", "dependency:4:Editor"]);
      expect(store.getQueueItem(item.id).confirmed).toEqual(["save:9:CustomSave", "dependency:4:Editor"]);
      // Confirming does not make it another render.
      expect(store.findActiveQueueItem({ fingerprint: "fp-1", recipeId: 1, knobs: {} })?.id).toBe(item.id);
      expect(store.getQueueItem(item.id).knobs).toEqual({ choices: {}, settings: {} });
    });

    it("records finals and finds the latest for a draft, recipe and knobs", () => {
      store.addFinal({ fingerprint: "fp-1", draftPath: "/out/a.mp4", finalPath: "/out/a_final_1.mp4", recipeId: 1, recipeName: "Omni", knobs: {}, seconds: 60, finishedAt: 1 });
      store.addFinal({ fingerprint: "fp-1", draftPath: "/out/a.mp4", finalPath: "/out/a_final_2.mp4", recipeId: 1, recipeName: "Omni", knobs: {}, seconds: 61, finishedAt: 2 });
      store.addFinal({ fingerprint: "fp-1", draftPath: "/out/a.mp4", finalPath: "/out/a_final_x.mp4", recipeId: 1, knobs: { settings: { s: 1 } }, finishedAt: 3 });
      expect(store.findFinal({ fingerprint: "fp-1", recipeId: 1, knobs: {} }).finalPath).toBe("/out/a_final_2.mp4");
      expect(store.findFinal({ fingerprint: "fp-1", recipeId: 2, knobs: {} })).toBeNull();
      expect(store.listFinals({ limit: 2 }).map((final) => final.finalPath)).toEqual(["/out/a_final_x.mp4", "/out/a_final_2.mp4"]);
    });
  });
}

module.exports = { describeComfyQueueStore };
