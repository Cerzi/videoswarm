const path = require('path');
const { applyRecipe } = require('./comfy-recipe');
const { checkPrompt, classesToCheck } = require('./comfy-checks');
const { classifyHistoryEntry, createComfyClient } = require('./comfy-client');
const { parseComfyGraphJson, stringifyComfyGraphJson } = require('./comfy-graph-json');
const { normalizeKnobs } = require('./comfy-queue-store');

// The re-render queue's engine, in the main process. One prompt is in
// ComfyUI's queue at a time, so the user's own generations slot in between
// and the page order is the run order. Each clip is prepared just before it
// is sent: its recipe applied to the draft, the checks run against ComfyUI's
// node definitions, and the final named to land beside its draft. The runner
// polls ComfyUI's /queue and /history; it never restarts ComfyUI.
// See docs/architecture/comfy-queue-integration.md, Section 6.

const ORDERS = Object.freeze(['first-added', 'last-added', 'shortest', 'longest']);
const IN_FLIGHT = new Set(['waiting', 'rendering']);
const DEFAULT_POLL_MS = 3000;
const CHECK_TTL_MS = 60_000;
const LOST_POLLS = 3;
const MAX_CHECKS_PER_TICK = 16;
const MAX_ADD = 512;
const LOST_REASON = 'ComfyUI stopped during it (crashed or restarted?)';

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

function slug(value, max = 40) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
}

// What the final's name says about how it was made: the recipe's name, then
// each setting the user changed (`steps50`).
function knobSummary(recipe, knobs) {
  const parts = [slug(recipe?.name) || `recipe${recipe?.id ?? ''}`];
  const settings = isObject(knobs?.settings) ? knobs.settings : {};
  const ops = Array.isArray(recipe?.recipe?.ops) ? recipe.recipe.ops : [];
  for (const id of Object.keys(settings).sort()) {
    const op = ops.find((entry) => entry.id === id);
    const name = op?.effects?.[0]?.input || op?.input || id;
    const value = settings[id];
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      parts.push(`${slug(name, 20)}${slug(String(value), 20)}`);
    }
  }
  return parts.join('_');
}

// Where ComfyUI should save the final, as a filename_prefix relative to its
// output folder: beside the draft (`H3/2026-09-26/213533_00001_final_<label>`)
// when the draft is inside that folder, otherwise in the draft's own save
// folder, as its embedded prefix names it.
function finalPrefix({ draftPath, outputDir, draftPrompt, label }) {
  const stem = path.basename(draftPath, path.extname(draftPath)).replace(/_+$/, '');
  const name = `${stem}_final_${label}`;
  if (outputDir) {
    const relative = path.relative(outputDir, path.dirname(draftPath));
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      const parts = relative.split(path.sep).filter(Boolean);
      return [...parts, name].join('/');
    }
  }
  const saved = Object.values(isObject(draftPrompt) ? draftPrompt : {})
    .map((node) => node?.inputs?.filename_prefix)
    .find((prefix) => typeof prefix === 'string' && prefix.trim());
  const folder = saved ? path.posix.dirname(saved.replace(/\\/g, '/')) : '.';
  return folder && folder !== '.' && !folder.startsWith('/') && !folder.split('/').includes('..')
    ? `${folder}/${name}`
    : name;
}

// Where the provenance tag says the draft was: inside ComfyUI's output folder
// as a relative path, as comfy-requeue records it; elsewhere only its name, so
// a shared final does not carry the user's folder layout.
function sourcePathFor(draftPath, outputDir) {
  if (outputDir) {
    const relative = path.relative(outputDir, draftPath);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) return relative.split(path.sep).join('/');
  }
  return path.basename(draftPath);
}

function createComfyRunner({
  store,
  getConnection,
  readDraft,
  createClient = (url) => createComfyClient({ url }),
  now = () => Date.now(),
  pollMs = DEFAULT_POLL_MS,
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = (handle) => clearTimeout(handle),
  emit = () => {},
  logger = console,
}) {
  let client = null;
  let clientUrl = null;
  let running = false;
  let order = 'first-added';
  let comfyUp = null;
  let adopted = false;
  let disposed = false;
  let timer = null;
  let ticking = null;
  const lost = new Map(); // item id -> polls missing from /queue and /history
  const checks = new Map(); // item id -> { at, problems }
  const drafts = new Map(); // draft path -> { prompt, workflow }
  const log = [];

  const note = (message) => {
    log.push({ at: now(), message });
    if (log.length > 200) log.shift();
  };
  const changed = (reason, extra = {}) => {
    try {
      emit({ type: 'changed', reason, ...extra });
    } catch (error) {
      logger.warn?.('[comfy] event listener failed', error);
    }
  };

  function connection() {
    const value = getConnection() || {};
    return { enabled: value.enabled === true, url: value.url, outputDir: value.outputDir || null };
  }

  function currentClient() {
    const { enabled, url } = connection();
    if (!enabled) return null;
    if (!client || clientUrl !== url) {
      client = createClient(url);
      clientUrl = url;
    }
    return client;
  }

  const inFlight = () => store.listQueueItems().filter((item) => IN_FLIGHT.has(item.state));

  function ordered(items) {
    const ready = items.filter((item) => item.state === 'ready');
    // Estimates arrive in Phase 4; until then the estimate orders fall back
    // to the order clips were added.
    return order === 'last-added' ? ready.slice().reverse() : ready;
  }

  async function draftOf(item) {
    if (drafts.has(item.draftPath)) return drafts.get(item.draftPath);
    const raw = await readDraft(item.draftPath);
    const parse = (value) => (typeof value === 'string' ? parseComfyGraphJson(value) : value ?? null);
    const draft = { prompt: parse(raw?.prompt), workflow: parse(raw?.workflow) };
    if (!isObject(draft.prompt)) throw new Error('The draft carries no ComfyUI prompt');
    if (drafts.size > 256) drafts.delete(drafts.keys().next().value);
    drafts.set(item.draftPath, draft);
    return draft;
  }

  // Everything needed to send one clip, or the reason it cannot be sent.
  async function prepare(item, comfy) {
    const recipe = store.getRecipe(item.recipeId);
    if (!recipe) return { problems: [{ code: 'COMFY_RECIPE_MISSING', message: 'Its recipe was deleted' }] };
    let draft;
    try {
      draft = await draftOf(item);
    } catch (error) {
      return { problems: [{ code: 'COMFY_DRAFT_UNREADABLE', message: `Cannot read the draft: ${error.message}` }] };
    }
    const { outputDir } = connection();
    const prefix = finalPrefix({
      draftPath: item.draftPath,
      outputDir,
      draftPrompt: draft.prompt,
      label: knobSummary(recipe, item.knobs),
    });
    const applied = applyRecipe(recipe.recipe, draft, {
      settings: item.knobs?.settings,
      choices: item.knobs?.choices,
      filenamePrefix: prefix,
    });
    if (applied.error) return { problems: [{ code: applied.error.code, message: applied.error.message }] };
    const info = await comfy.getNodeInfo(classesToCheck(applied.prompt));
    const problems = checkPrompt(applied.prompt, info);
    const requeue = {
      source_path: sourcePathFor(item.draftPath, outputDir),
      source_prompt: draft.prompt,
      source_workflow: draft.workflow,
      recipe: { id: recipe.id, name: recipe.name },
      settings: item.knobs?.settings || {},
      choices: item.knobs?.choices || {},
      passes: 'single',
      phase: 'single',
      videoswarm: { item: item.id, fingerprint: item.fingerprint },
    };
    const extraPnginfo = { requeue };
    if (applied.workflow) extraPnginfo.workflow = applied.workflow;
    return { problems, prompt: applied.prompt, extraPnginfo, prefix };
  }

  function recordChecks(item, problems) {
    checks.set(item.id, { at: now(), problems });
    const blocked = problems.length > 0;
    if (blocked && item.state === 'ready') {
      store.updateQueueItem(item.id, { state: 'blocked', detail: problems[0].message });
      changed('blocked', { id: item.id });
    } else if (!blocked && item.state === 'blocked') {
      store.updateQueueItem(item.id, { state: 'ready', detail: null });
      changed('unblocked', { id: item.id });
    }
  }

  // Re-run checks that are older than a minute, so a clip blocked by a
  // missing LoRA becomes ready once the LoRA is installed.
  async function refreshChecks(comfy) {
    const stale = store
      .listQueueItems()
      .filter((item) => (item.state === 'ready' || item.state === 'blocked') && !(now() - (checks.get(item.id)?.at ?? -Infinity) < CHECK_TTL_MS))
      .slice(0, MAX_CHECKS_PER_TICK);
    for (const item of stale) {
      const prepared = await prepare(item, comfy);
      recordChecks(store.getQueueItem(item.id), prepared.problems);
    }
  }

  // Our own prompts still on ComfyUI's queue after a restart, recognised by
  // the draft's prompt their provenance tag carries.
  async function adopt(queue) {
    adopted = true;
    const entries = [...queue.running, ...queue.pending];
    const items = store.listQueueItems();
    for (const entry of entries) {
      const tag = entry.extraData?.extra_pnginfo?.requeue;
      if (!isObject(tag) || !isObject(tag.videoswarm) || !isObject(tag.source_prompt)) continue;
      if (items.some((item) => item.promptId === entry.promptId)) continue;
      const wanted = stringifyComfyGraphJson(tag.source_prompt);
      const candidates = items
        .filter((item) => !IN_FLIGHT.has(item.state) && item.state !== 'done')
        .sort((a, b) => Number(b.id === tag.videoswarm.item) - Number(a.id === tag.videoswarm.item));
      for (const item of candidates) {
        let draft;
        try {
          draft = await draftOf(item);
        } catch {
          continue;
        }
        if (stringifyComfyGraphJson(draft.prompt) !== wanted) continue;
        const state = queue.running.includes(entry) ? 'rendering' : 'waiting';
        store.updateQueueItem(item.id, { state, promptId: entry.promptId, detail: null });
        running = true;
        note(`Picked up ${path.basename(item.draftPath)} from ComfyUI's queue`);
        changed('adopted', { id: item.id });
        break;
      }
    }
  }

  function finish(item, entry) {
    const outcome = classifyHistoryEntry(entry);
    lost.delete(item.id);
    if (outcome.state === 'ok') {
      const { outputDir } = connection();
      const file = outcome.outputs[0];
      let finalPath = null;
      if (file && outputDir) {
        const candidate = path.resolve(outputDir, file.subfolder || '', file.filename);
        const relative = path.relative(outputDir, candidate);
        if (!relative.startsWith('..') && !path.isAbsolute(relative)) finalPath = candidate;
      }
      const noteText = finalPath ? '' : 'ComfyUI saved no output file';
      store.updateQueueItem(item.id, { state: 'done', finalPath, seconds: outcome.seconds, detail: noteText || null });
      if (finalPath) {
        const recipe = store.getRecipe(item.recipeId);
        store.addFinal({
          fingerprint: item.fingerprint,
          draftPath: item.draftPath,
          finalPath,
          recipeId: item.recipeId,
          recipeName: recipe?.name ?? null,
          knobs: item.knobs,
          seconds: outcome.seconds,
          note: noteText,
        });
      }
      note(`${path.basename(item.draftPath)} done${finalPath ? ` → ${path.basename(finalPath)}` : ''}`);
      changed('done', { id: item.id });
      return;
    }
    const detail =
      outcome.state === 'oom'
        ? `Out of memory${outcome.nodeType ? ` in ${outcome.nodeType}` : ''}: ${outcome.message}`
        : outcome.state === 'interrupted'
          ? 'Interrupted in ComfyUI'
          : `${outcome.nodeType ? `${outcome.nodeType}: ` : ''}${outcome.message || 'failed'}`;
    store.updateQueueItem(item.id, { state: 'failed', detail, seconds: outcome.seconds });
    note(`${path.basename(item.draftPath)} failed — ${detail}`);
    changed('failed', { id: item.id });
  }

  async function reconcile(queue, comfy) {
    const running = new Set(queue.running.map((entry) => entry.promptId));
    const pending = new Set(queue.pending.map((entry) => entry.promptId));
    for (const item of inFlight()) {
      if (!item.promptId) {
        store.updateQueueItem(item.id, { state: 'ready' });
        continue;
      }
      if (running.has(item.promptId)) {
        lost.delete(item.id);
        if (item.state !== 'rendering') {
          store.updateQueueItem(item.id, { state: 'rendering' });
          changed('rendering', { id: item.id });
        }
        continue;
      }
      if (pending.has(item.promptId)) {
        lost.delete(item.id);
        continue;
      }
      const entry = await comfy.getHistory(item.promptId);
      if (entry) {
        finish(item, entry);
        continue;
      }
      // Neither queued nor in history while ComfyUI answers: it restarted
      // or crashed under this prompt. The queue goes on without it.
      const count = (lost.get(item.id) || 0) + 1;
      lost.set(item.id, count);
      if (count >= LOST_POLLS) {
        lost.delete(item.id);
        store.updateQueueItem(item.id, { state: 'failed', detail: LOST_REASON });
        note(`${path.basename(item.draftPath)} failed — ${LOST_REASON}`);
        changed('failed', { id: item.id });
      }
    }
  }

  async function feed(comfy) {
    if (inFlight().length) return;
    for (const item of ordered(store.listQueueItems())) {
      const prepared = await prepare(item, comfy);
      recordChecks(item, prepared.problems);
      if (prepared.problems.length) continue;
      try {
        const promptId = await comfy.submitPrompt({ prompt: prepared.prompt, extraPnginfo: prepared.extraPnginfo });
        store.updateQueueItem(item.id, { state: 'waiting', promptId, attempts: item.attempts + 1, detail: null });
        note(`Queued ${path.basename(item.draftPath)} as ${prepared.prefix}`);
        changed('queued', { id: item.id });
      } catch (error) {
        if (error.code === 'COMFY_UNAVAILABLE') throw error;
        store.updateQueueItem(item.id, { state: 'failed', detail: error.message });
        note(`${path.basename(item.draftPath)} failed — ${error.message}`);
        changed('failed', { id: item.id });
        continue;
      }
      return;
    }
    if (!inFlight().length) {
      running = false;
      note('Finished: nothing left to render');
      changed('finished');
    }
  }

  async function tickOnce() {
    const comfy = currentClient();
    if (!comfy) {
      if (comfyUp !== null) changed('connection', { comfyUp: null });
      comfyUp = null;
      running = false;
      return;
    }
    let queue;
    try {
      queue = await comfy.getQueue();
      if (comfyUp !== true) {
        comfyUp = true;
        changed('connection', { comfyUp });
      }
      if (!adopted) await adopt(queue);
      await reconcile(queue, comfy);
      await refreshChecks(comfy);
      if (running) await feed(comfy);
    } catch (error) {
      if (error.code !== 'COMFY_UNAVAILABLE') {
        logger.warn?.('[comfy] runner tick failed', error);
        note(`Runner error: ${error.message}`);
      }
      if (comfyUp !== false) {
        comfyUp = false;
        note('ComfyUI is not reachable');
        changed('connection', { comfyUp });
      }
    }
  }

  const wantsTicks = () =>
    !disposed &&
    connection().enabled &&
    (running ||
      !adopted ||
      store.listQueueItems().some((item) => IN_FLIGHT.has(item.state) || item.state === 'ready' || item.state === 'blocked'));

  function schedule() {
    if (timer || !wantsTicks()) return;
    timer = setTimer(() => {
      timer = null;
      void tick();
    }, pollMs);
  }

  // One poll: exposed for tests and for an immediate refresh.
  function tick() {
    if (disposed) return Promise.resolve();
    if (!ticking) {
      ticking = tickOnce().finally(() => {
        ticking = null;
        schedule();
      });
    }
    return ticking;
  }

  function cancelTimer() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  // --- what the interface can ask for ---

  function snapshot() {
    const items = store.listQueueItems();
    const queue = ordered(items);
    const position = new Map(queue.map((item, index) => [item.id, index + 1]));
    const { enabled } = connection();
    return {
      enabled,
      comfyUp,
      running,
      order,
      active: running || items.some((item) => IN_FLIGHT.has(item.state)),
      items: items.map((item) => ({
        id: item.id,
        fingerprint: item.fingerprint,
        draftPath: item.draftPath,
        recipeId: item.recipeId,
        knobs: item.knobs,
        addedAt: item.addedAt,
        state: item.state,
        detail: item.detail,
        finalPath: item.finalPath,
        seconds: item.seconds,
        attempts: item.attempts,
        position: position.get(item.id) ?? null,
        problems: checks.get(item.id)?.problems ?? null,
      })),
      log: log.slice(-40),
    };
  }

  // Add drafts with a recipe. A draft already queued with the same recipe and
  // settings runs once; one already rendered that way is held, linked to its
  // final, until the user asks to render it again.
  function addClips({ clips, recipeId, knobs }) {
    if (!store.getRecipe(recipeId)) {
      throw Object.assign(new Error('No such recipe'), { code: 'COMFY_RECIPE_MISSING' });
    }
    const list = Array.isArray(clips) ? clips.slice(0, MAX_ADD) : [];
    const result = { added: [], duplicates: [], held: [] };
    for (const clip of list) {
      const key = { fingerprint: clip.fingerprint, recipeId, knobs };
      const active = store.findActiveQueueItem(key);
      if (active) {
        result.duplicates.push(active.id);
        continue;
      }
      // A failed clip added again is retried rather than queued twice.
      const { knobsKey } = normalizeKnobs(knobs);
      const retry = store
        .listQueueItems()
        .find(
          (item) =>
            item.state === 'failed' &&
            item.fingerprint === clip.fingerprint &&
            item.recipeId === Number(recipeId) &&
            item.knobsKey === knobsKey
        );
      if (retry) {
        store.updateQueueItem(retry.id, { state: 'ready', detail: null, promptId: null, draftPath: clip.draftPath });
        result.added.push(retry.id);
        continue;
      }
      const final = store.findFinal(key);
      const item = store.addQueueItem({
        fingerprint: clip.fingerprint,
        draftPath: clip.draftPath,
        recipeId,
        knobs,
        addedAt: now(),
        state: final ? 'held' : 'ready',
        finalPath: final?.finalPath ?? null,
        detail: final ? `Rendered before with this recipe → ${path.basename(final.finalPath)}` : null,
      });
      (final ? result.held : result.added).push(item.id);
    }
    if (result.added.length || result.held.length) changed('added');
    schedule();
    return result;
  }

  function start() {
    running = true;
    note('Started');
    changed('started');
    return tick();
  }

  // Stop feeding: a render in progress finishes, a prompt still waiting in
  // ComfyUI's queue is withdrawn and goes back to ready.
  async function stop() {
    running = false;
    const waiting = inFlight().filter((item) => item.state === 'waiting' && item.promptId);
    const comfy = currentClient();
    if (waiting.length && comfy) {
      try {
        await comfy.deleteQueued(waiting.map((item) => item.promptId));
      } catch (error) {
        logger.warn?.('[comfy] could not withdraw waiting prompts', error);
      }
      // A prompt that started meanwhile keeps rendering; the next poll sees it.
      const queue = await comfy.getQueue().catch(() => null);
      const started = new Set((queue?.running || []).map((entry) => entry.promptId));
      for (const item of waiting) {
        if (started.has(item.promptId)) continue;
        store.updateQueueItem(item.id, { state: 'ready', promptId: null });
      }
    }
    note('Stopped: the current render will finish');
    changed('stopped');
  }

  function setOrder(next) {
    if (!ORDERS.includes(next)) throw Object.assign(new Error(`Unknown order: ${next}`), { code: 'COMFY_ORDER_INVALID' });
    order = next;
    changed('order');
  }

  function renderAgain(id) {
    const item = store.getQueueItem(id);
    if (!item || item.state !== 'held') return false;
    store.updateQueueItem(id, { state: 'ready', renderAgain: true, detail: null });
    changed('render-again', { id });
    schedule();
    return true;
  }

  function retry(id) {
    const item = store.getQueueItem(id);
    if (!item || (item.state !== 'failed' && item.state !== 'blocked')) return false;
    checks.delete(item.id);
    drafts.delete(item.draftPath);
    store.updateQueueItem(id, { state: 'ready', detail: null, promptId: null });
    changed('retry', { id });
    schedule();
    return true;
  }

  async function remove(id) {
    const item = store.getQueueItem(id);
    if (!item) return false;
    if (item.state === 'rendering') {
      throw Object.assign(new Error('It is rendering; stop the queue and let it finish'), { code: 'COMFY_ITEM_RENDERING' });
    }
    if (item.state === 'waiting' && item.promptId) await currentClient()?.deleteQueued([item.promptId]);
    checks.delete(item.id);
    store.removeQueueItem(id);
    changed('removed', { id });
    return true;
  }

  // The connection changed: a new address gets a new client; switched off,
  // the runner stops polling (prompts already in ComfyUI keep rendering and
  // are reconciled when it is switched on again).
  function reconfigure() {
    client = null;
    clientUrl = null;
    adopted = false;
    checks.clear();
    if (!connection().enabled) {
      running = false;
      cancelTimer();
    }
    changed('connection', { comfyUp });
    schedule();
  }

  async function dispose() {
    disposed = true;
    cancelTimer();
    await ticking?.catch(() => {});
  }

  return {
    addClips,
    start,
    stop,
    setOrder,
    renderAgain,
    retry,
    remove,
    reconfigure,
    resume: () => (connection().enabled ? tick() : Promise.resolve()),
    tick,
    snapshot,
    history: (options) => store.listFinals(options),
    isActive: () => running || inFlight().length > 0,
    hasPromptInComfy: () => inFlight().length > 0,
    stopFeeding: () => {
      running = false;
    },
    dispose,
  };
}

module.exports = { ORDERS, createComfyRunner, finalPrefix, knobSummary, sourcePathFor };
