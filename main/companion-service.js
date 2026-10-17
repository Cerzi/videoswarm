const { createCompanionClient } = require("./companion-client");
const { normalizeCompanionConnection } = require("./companion-connection");

// The main process's side of the companion app
// (docs/architecture/companion-app.md): the connection setting, the
// companion's description (its actions), and lookups and sends by path. The
// renderer names catalog rows; main.js turns them into paths before they
// reach this module.

const DESCRIPTION_TTL_MS = 60_000;

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

  async function send({ action, paths, dryRun = false, again = false }) {
    const description = await describe();
    if (!description.actions.some((entry) => entry.id === action)) {
      throw Object.assign(new Error("The companion app does not offer that action"), {
        code: "COMPANION_UNKNOWN_ACTION",
      });
    }
    const { url } = connection();
    return createClient({ url }).send({ action, paths, dryRun, again });
  }

  // A one-off check of an address the user typed, connected or not.
  async function test(url) {
    return createClient({ url }).describe();
  }

  return {
    describe,
    lookup,
    send,
    test,
    forget: () => {
      cached = null;
    },
  };
}

module.exports = { CompanionOffError, createCompanionService };
