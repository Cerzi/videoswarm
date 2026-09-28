const { parseComfyGraphJson, stringifyComfyGraphJson } = require('./comfy-graph-json');

// Recipes, the re-render queue and the history of finals, in the profile's
// SQLite database. The same contract is available in memory for tests of the
// runner, which cannot load the Electron-built SQLite module under Node.
// See docs/architecture/comfy-queue-integration.md, Section 6.

const QUEUE_STATES = Object.freeze(['ready', 'waiting', 'rendering', 'done', 'failed', 'held', 'blocked']);
const ACTIVE_STATES = new Set(['ready', 'waiting', 'rendering', 'held', 'blocked']);
const LIMITS = Object.freeze({
  maxRecipeBytes: 4 * 1024 * 1024,
  maxKnobsBytes: 64 * 1024,
  maxNameLength: 120,
  maxPathLength: 4096,
  maxDetailLength: 2000,
  maxFinals: 500,
});

class ComfyQueueStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ComfyQueueStoreError';
    this.code = code;
  }
}

// Knobs are the user's settings and rule choices for one queue item. Their
// key is order-independent, so the same choices always compare equal.
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function normalizeKnobs(knobs) {
  const source = knobs && typeof knobs === 'object' && !Array.isArray(knobs) ? knobs : {};
  const pick = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
  const normalized = canonicalize({ settings: pick(source.settings), choices: pick(source.choices) });
  const key = stringifyComfyGraphJson(normalized);
  if (Buffer.byteLength(key, 'utf8') > LIMITS.maxKnobsBytes) {
    throw new ComfyQueueStoreError('COMFY_KNOBS_TOO_LARGE', 'Too many settings for one queue item');
  }
  return { knobs: normalized, knobsKey: key };
}

const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);

function assertState(state) {
  if (!QUEUE_STATES.includes(state)) {
    throw new ComfyQueueStoreError('COMFY_STATE_INVALID', `Unknown queue state: ${state}`);
  }
}

function assertPath(value, what) {
  if (typeof value !== 'string' || !value || value.length > LIMITS.maxPathLength) {
    throw new ComfyQueueStoreError('COMFY_PATH_INVALID', `${what} must be a path`);
  }
  return value;
}

function serializeRecipe(recipe) {
  const json = stringifyComfyGraphJson(recipe);
  if (Buffer.byteLength(json, 'utf8') > LIMITS.maxRecipeBytes) {
    throw new ComfyQueueStoreError('COMFY_RECIPE_TOO_LARGE', 'The recipe is too large to save');
  }
  return json;
}

const recipeSummary = (row, recipe) => ({
  id: row.id,
  name: row.name,
  createdAt: row.createdAt,
  learnedFrom: Array.isArray(recipe?.learnedFrom) ? recipe.learnedFrom.slice(0, 16) : [],
  operations: Array.isArray(recipe?.ops) ? recipe.ops.length : 0,
  varies: Array.isArray(recipe?.ops) ? recipe.ops.filter((op) => op.status === 'varies').length : 0,
});

const UPDATABLE = {
  state: (value) => (assertState(value), value),
  promptId: (value) => text(value, 128),
  attempts: (value) => Math.max(0, Math.floor(Number(value) || 0)),
  detail: (value) => text(value, LIMITS.maxDetailLength),
  finalPath: (value) => text(value, LIMITS.maxPathLength),
  seconds: (value) => (Number.isFinite(value) ? value : null),
  renderAgain: (value) => value === true,
  draftPath: (value) => assertPath(value, 'The draft'),
};

// --- memory ---------------------------------------------------------------

function createMemoryComfyQueueStore({ now = () => Date.now() } = {}) {
  const recipes = new Map();
  const items = new Map();
  const finals = [];
  let nextId = { recipe: 1, item: 1, final: 1 };
  const copy = (value) => (value === undefined ? undefined : structuredClone(value));

  return {
    saveRecipe({ name, recipe }) {
      const row = { id: nextId.recipe++, name: text(name, LIMITS.maxNameLength) || 'Recipe', json: serializeRecipe(recipe), createdAt: now() };
      recipes.set(row.id, row);
      return recipeSummary(row, recipe);
    },
    listRecipes: () => [...recipes.values()].map((row) => recipeSummary(row, parseComfyGraphJson(row.json))),
    getRecipe(id) {
      const row = recipes.get(Number(id));
      return row ? { id: row.id, name: row.name, createdAt: row.createdAt, recipe: parseComfyGraphJson(row.json) } : null;
    },
    deleteRecipe: (id) => recipes.delete(Number(id)),

    addQueueItem(input) {
      const { knobs, knobsKey } = normalizeKnobs(input.knobs);
      const state = input.state || 'ready';
      assertState(state);
      const item = {
        id: nextId.item++,
        fingerprint: assertPath(input.fingerprint, 'The fingerprint'),
        draftPath: assertPath(input.draftPath, 'The draft'),
        recipeId: Number(input.recipeId),
        knobs,
        knobsKey,
        addedAt: Number.isFinite(input.addedAt) ? input.addedAt : now(),
        state,
        promptId: null,
        attempts: 0,
        detail: text(input.detail, LIMITS.maxDetailLength),
        finalPath: text(input.finalPath, LIMITS.maxPathLength),
        seconds: null,
        renderAgain: false,
        updatedAt: now(),
      };
      items.set(item.id, item);
      return copy(item);
    },
    findActiveQueueItem({ fingerprint, recipeId, knobs }) {
      const { knobsKey } = normalizeKnobs(knobs);
      const found = [...items.values()].find(
        (item) =>
          item.fingerprint === fingerprint &&
          item.recipeId === Number(recipeId) &&
          item.knobsKey === knobsKey &&
          ACTIVE_STATES.has(item.state)
      );
      return copy(found) || null;
    },
    listQueueItems: () =>
      [...items.values()].sort((a, b) => a.addedAt - b.addedAt || a.id - b.id).map(copy),
    getQueueItem: (id) => copy(items.get(Number(id))) || null,
    updateQueueItem(id, patch) {
      const item = items.get(Number(id));
      if (!item) return null;
      for (const [key, value] of Object.entries(patch || {})) {
        if (UPDATABLE[key]) item[key] = UPDATABLE[key](value);
      }
      item.updatedAt = now();
      return copy(item);
    },
    removeQueueItem: (id) => items.delete(Number(id)),

    addFinal(input) {
      const { knobs, knobsKey } = normalizeKnobs(input.knobs);
      const final = {
        id: nextId.final++,
        fingerprint: assertPath(input.fingerprint, 'The fingerprint'),
        draftPath: assertPath(input.draftPath, 'The draft'),
        finalPath: assertPath(input.finalPath, 'The final'),
        recipeId: Number(input.recipeId),
        recipeName: text(input.recipeName, LIMITS.maxNameLength),
        knobs,
        knobsKey,
        seconds: Number.isFinite(input.seconds) ? input.seconds : null,
        note: text(input.note, LIMITS.maxDetailLength),
        finishedAt: Number.isFinite(input.finishedAt) ? input.finishedAt : now(),
      };
      finals.push(final);
      return copy(final);
    },
    findFinal({ fingerprint, recipeId, knobs }) {
      const { knobsKey } = normalizeKnobs(knobs);
      const found = finals
        .filter((final) => final.fingerprint === fingerprint && final.recipeId === Number(recipeId) && final.knobsKey === knobsKey)
        .at(-1);
      return copy(found) || null;
    },
    listFinals: ({ limit = 200 } = {}) =>
      finals
        .slice()
        .sort((a, b) => b.finishedAt - a.finishedAt || b.id - a.id)
        .slice(0, Math.min(limit, LIMITS.maxFinals))
        .map(copy),
  };
}

// --- SQLite ------------------------------------------------------------------

function migrateComfyQueueTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS comfy_recipes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      recipe_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS comfy_queue_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fingerprint TEXT NOT NULL,
      draft_path TEXT NOT NULL,
      recipe_id INTEGER NOT NULL,
      knobs_json TEXT NOT NULL,
      knobs_key TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN (${QUEUE_STATES.map((state) => `'${state}'`).join(', ')})),
      prompt_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      detail TEXT,
      final_path TEXT,
      seconds REAL,
      render_again INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comfy_queue_items_draft
      ON comfy_queue_items(fingerprint, recipe_id, knobs_key);
    CREATE TABLE IF NOT EXISTS comfy_finals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fingerprint TEXT NOT NULL,
      draft_path TEXT NOT NULL,
      final_path TEXT NOT NULL,
      recipe_id INTEGER NOT NULL,
      recipe_name TEXT,
      knobs_json TEXT NOT NULL,
      knobs_key TEXT NOT NULL,
      seconds REAL,
      note TEXT,
      finished_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comfy_finals_draft
      ON comfy_finals(fingerprint, recipe_id, knobs_key);
  `);
}

function createComfyQueueStore(db, { now = () => Date.now() } = {}) {
  migrateComfyQueueTables(db);
  const statements = {
    insertRecipe: db.prepare('INSERT INTO comfy_recipes (name, recipe_json, created_at) VALUES (?, ?, ?)'),
    listRecipes: db.prepare('SELECT id, name, recipe_json AS json, created_at AS createdAt FROM comfy_recipes ORDER BY id'),
    getRecipe: db.prepare('SELECT id, name, recipe_json AS json, created_at AS createdAt FROM comfy_recipes WHERE id = ?'),
    deleteRecipe: db.prepare('DELETE FROM comfy_recipes WHERE id = ?'),
    insertItem: db.prepare(`
      INSERT INTO comfy_queue_items
        (fingerprint, draft_path, recipe_id, knobs_json, knobs_key, added_at, state, detail, final_path, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    getItem: db.prepare('SELECT * FROM comfy_queue_items WHERE id = ?'),
    listItems: db.prepare('SELECT * FROM comfy_queue_items ORDER BY added_at, id'),
    findActive: db.prepare(`
      SELECT * FROM comfy_queue_items
      WHERE fingerprint = ? AND recipe_id = ? AND knobs_key = ?
        AND state IN (${[...ACTIVE_STATES].map((state) => `'${state}'`).join(', ')})
      ORDER BY id LIMIT 1`),
    removeItem: db.prepare('DELETE FROM comfy_queue_items WHERE id = ?'),
    insertFinal: db.prepare(`
      INSERT INTO comfy_finals
        (fingerprint, draft_path, final_path, recipe_id, recipe_name, knobs_json, knobs_key, seconds, note, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    getFinal: db.prepare('SELECT * FROM comfy_finals WHERE id = ?'),
    findFinal: db.prepare(`
      SELECT * FROM comfy_finals WHERE fingerprint = ? AND recipe_id = ? AND knobs_key = ?
      ORDER BY id DESC LIMIT 1`),
    listFinals: db.prepare('SELECT * FROM comfy_finals ORDER BY finished_at DESC, id DESC LIMIT ?'),
  };
  const COLUMNS = {
    state: 'state',
    promptId: 'prompt_id',
    attempts: 'attempts',
    detail: 'detail',
    finalPath: 'final_path',
    seconds: 'seconds',
    renderAgain: 'render_again',
    draftPath: 'draft_path',
  };

  const mapItem = (row) =>
    row
      ? {
          id: row.id,
          fingerprint: row.fingerprint,
          draftPath: row.draft_path,
          recipeId: row.recipe_id,
          knobs: parseComfyGraphJson(row.knobs_json),
          knobsKey: row.knobs_key,
          addedAt: row.added_at,
          state: row.state,
          promptId: row.prompt_id,
          attempts: row.attempts,
          detail: row.detail,
          finalPath: row.final_path,
          seconds: row.seconds,
          renderAgain: row.render_again === 1,
          updatedAt: row.updated_at,
        }
      : null;
  const mapFinal = (row) =>
    row
      ? {
          id: row.id,
          fingerprint: row.fingerprint,
          draftPath: row.draft_path,
          finalPath: row.final_path,
          recipeId: row.recipe_id,
          recipeName: row.recipe_name,
          knobs: parseComfyGraphJson(row.knobs_json),
          knobsKey: row.knobs_key,
          seconds: row.seconds,
          note: row.note,
          finishedAt: row.finished_at,
        }
      : null;

  return {
    saveRecipe({ name, recipe }) {
      const row = { name: text(name, LIMITS.maxNameLength) || 'Recipe', json: serializeRecipe(recipe), createdAt: now() };
      const info = statements.insertRecipe.run(row.name, row.json, row.createdAt);
      return recipeSummary({ ...row, id: Number(info.lastInsertRowid) }, recipe);
    },
    listRecipes: () => statements.listRecipes.all().map((row) => recipeSummary(row, parseComfyGraphJson(row.json))),
    getRecipe(id) {
      const row = statements.getRecipe.get(Number(id));
      return row ? { id: row.id, name: row.name, createdAt: row.createdAt, recipe: parseComfyGraphJson(row.json) } : null;
    },
    deleteRecipe: (id) => statements.deleteRecipe.run(Number(id)).changes > 0,

    addQueueItem(input) {
      const { knobs, knobsKey } = normalizeKnobs(input.knobs);
      const state = input.state || 'ready';
      assertState(state);
      const info = statements.insertItem.run(
        assertPath(input.fingerprint, 'The fingerprint'),
        assertPath(input.draftPath, 'The draft'),
        Number(input.recipeId),
        stringifyComfyGraphJson(knobs),
        knobsKey,
        Number.isFinite(input.addedAt) ? input.addedAt : now(),
        state,
        text(input.detail, LIMITS.maxDetailLength),
        text(input.finalPath, LIMITS.maxPathLength),
        now()
      );
      return mapItem(statements.getItem.get(Number(info.lastInsertRowid)));
    },
    findActiveQueueItem({ fingerprint, recipeId, knobs }) {
      const { knobsKey } = normalizeKnobs(knobs);
      return mapItem(statements.findActive.get(fingerprint, Number(recipeId), knobsKey));
    },
    listQueueItems: () => statements.listItems.all().map(mapItem),
    getQueueItem: (id) => mapItem(statements.getItem.get(Number(id))),
    updateQueueItem(id, patch) {
      const sets = [];
      const values = [];
      for (const [key, value] of Object.entries(patch || {})) {
        if (!UPDATABLE[key]) continue;
        const normalized = UPDATABLE[key](value);
        sets.push(`${COLUMNS[key]} = ?`);
        values.push(key === 'renderAgain' ? Number(normalized) : normalized);
      }
      sets.push('updated_at = ?');
      values.push(now());
      db.prepare(`UPDATE comfy_queue_items SET ${sets.join(', ')} WHERE id = ?`).run(...values, Number(id));
      return mapItem(statements.getItem.get(Number(id)));
    },
    removeQueueItem: (id) => statements.removeItem.run(Number(id)).changes > 0,

    addFinal(input) {
      const { knobs, knobsKey } = normalizeKnobs(input.knobs);
      const info = statements.insertFinal.run(
        assertPath(input.fingerprint, 'The fingerprint'),
        assertPath(input.draftPath, 'The draft'),
        assertPath(input.finalPath, 'The final'),
        Number(input.recipeId),
        text(input.recipeName, LIMITS.maxNameLength),
        stringifyComfyGraphJson(knobs),
        knobsKey,
        Number.isFinite(input.seconds) ? input.seconds : null,
        text(input.note, LIMITS.maxDetailLength),
        Number.isFinite(input.finishedAt) ? input.finishedAt : now()
      );
      return mapFinal(statements.getFinal.get(Number(info.lastInsertRowid)));
    },
    findFinal({ fingerprint, recipeId, knobs }) {
      const { knobsKey } = normalizeKnobs(knobs);
      return mapFinal(statements.findFinal.get(fingerprint, Number(recipeId), knobsKey));
    },
    listFinals: ({ limit = 200 } = {}) =>
      statements.listFinals.all(Math.max(1, Math.min(Number(limit) || 200, LIMITS.maxFinals))).map(mapFinal),
  };
}

module.exports = {
  ComfyQueueStoreError,
  QUEUE_STATES,
  createComfyQueueStore,
  createMemoryComfyQueueStore,
  migrateComfyQueueTables,
  normalizeKnobs,
};
