const { createCompanionClient } = require("./companion-client");
const { normalizeCompanionConnection } = require("./companion-connection");

// The main process's side of the companion app
// (docs/architecture/companion-app.md): the connection setting, the
// companion's description (its actions), and lookups and sends by path. The
// renderer names catalog rows; main.js turns them into paths before they
// reach this module.

const DESCRIPTION_TTL_MS = 60_000;
// Target ids stay here: the renderer sees a short handle for each, so a
// target's id (often a folder path) never reaches the window or a log.
const MAX_TARGET_HANDLES = 2000;
const HANDLE = /^t[1-9][0-9]{0,9}$/;

class CompanionOffError extends Error {
  constructor() {
    super("The companion app is not connected");
    this.name = "CompanionOffError";
    this.code = "COMPANION_OFF";
  }
}

function createCompanionService({
  getConnection,
  createClient = createCompanionClient,
  now = () => Date.now(),
}) {
  let cached = null; // { url, at, description }
  const handleById = new Map(); // target id -> handle, oldest first
  const idByHandle = new Map();
  let nextHandle = 1;

  function handleFor(id) {
    let handle = handleById.get(id);
    if (!handle) {
      handle = `t${nextHandle++}`;
      handleById.set(id, handle);
      idByHandle.set(handle, id);
      while (handleById.size > MAX_TARGET_HANDLES) {
        const [oldestId, oldestHandle] = handleById.entries().next().value;
        handleById.delete(oldestId);
        idByHandle.delete(oldestHandle);
      }
    }
    return handle;
  }

  // `{ handle }` -> the id it stands for; `{ new: name }` as is; nothing when
  // none is named.
  function resolveTarget(target) {
    if (target === undefined || target === null) return null;
    if (typeof target.handle === "string") {
      const id = HANDLE.test(target.handle) ? idByHandle.get(target.handle) : undefined;
      if (!id) {
        throw Object.assign(new Error("That target is no longer offered; choose it again"), {
          code: "COMPANION_TARGET_UNKNOWN",
        });
      }
      return id;
    }
    return { new: target.new };
  }

  const answeredTarget = (target) =>
    target ? { handle: handleFor(target.id), label: target.label } : null;

  async function actionOf(id) {
    const description = await describe();
    const action = description.actions.find((entry) => entry.id === id);
    if (!action) {
      throw Object.assign(new Error("The companion app does not offer that action"), {
        code: "COMPANION_UNKNOWN_ACTION",
      });
    }
    return action;
  }

  function connection() {
    const value = normalizeCompanionConnection(getConnection());
    if (!value.enabled || !value.url) throw new CompanionOffError();
    return value;
  }

  async function describe({ fresh = false } = {}) {
    const { url } = connection();
    if (!fresh && cached && cached.url === url && now() - cached.at < DESCRIPTION_TTL_MS) {
      return cached.description;
    }
    const description = await createClient({ url }).describe();
    cached = { url, at: now(), description };
    return description;
  }

  async function lookup(paths) {
    const description = await describe();
    const { url } = connection();
    return createClient({ url }).lookup(
      paths,
      description.actions.map((action) => action.id)
    );
  }

  // The action's targets, asked for afresh (which is current changes as the
  // user works in the companion), each with a handle in place of its id.
  async function targets(action) {
    const offered = await actionOf(action);
    if (!offered.targets) return [];
    const { url } = connection();
    const list = await createClient({ url }).targets(action);
    return list.map(({ id, label, detail, current }) => ({
      handle: handleFor(id),
      label,
      detail,
      current,
    }));
  }

  // `target` is `{ handle }` from targets(), `{ new: name }`, or nothing.
  // Answers `{ results, target: { handle, label } | null }`.
  async function send({ action, paths, ratings = null, dryRun = false, again = false, target = null }) {
    await actionOf(action);
    const { url } = connection();
    const outcome = await createClient({ url }).send({
      action,
      paths,
      ratings,
      dryRun,
      again,
      target: resolveTarget(target),
    });
    return { results: outcome.results, target: answeredTarget(outcome.target) };
  }

  async function withdraw({ action, paths, target = null }) {
    const offered = await actionOf(action);
    if (!offered.withdraw) {
      throw Object.assign(new Error("That action cannot be taken back"), {
        code: "COMPANION_NO_WITHDRAW",
      });
    }
    const { url } = connection();
    const outcome = await createClient({ url }).withdraw({
      action,
      paths,
      target: resolveTarget(target),
    });
    return { results: outcome.results, target: answeredTarget(outcome.target) };
  }

  // A one-off check of an address the user typed, connected or not.
  async function test(url) {
    return createClient({ url }).describe();
  }

  return {
    describe,
    lookup,
    targets,
    send,
    withdraw,
    test,
    forget: () => {
      cached = null;
      handleById.clear();
      idByHandle.clear();
    },
  };
}

module.exports = { CompanionOffError, createCompanionService };
