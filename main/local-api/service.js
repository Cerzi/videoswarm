const {
  localApiConfigPath,
  newLocalApiToken,
  readLocalApiConfig,
  validateLocalApiChange,
  writeLocalApiConfig,
} = require("./config");
const { createLocalApiServer } = require("./server");

// The local read API as the app runs it (docs/architecture/local-read-api.md):
// its file, its server, and who read last, for Preferences.

function createLocalApiService({ getDataDir, handlers, logger = console }) {
  let config = null;
  let state = { running: false, port: null, error: null };
  let lastRead = null;
  const server = createLocalApiServer({
    handlers,
    getToken: () => (config?.enabled ? config.token : null),
    onRead: ({ userAgent }) => {
      lastRead = { userAgent: userAgent || "an app with no name", at: Date.now() };
    },
  });

  async function apply() {
    await server.stop();
    state = { running: false, port: null, error: null };
    if (!config?.enabled) return;
    try {
      const port = await server.start(config.port);
      state = { running: true, port, error: null };
    } catch (error) {
      state = {
        running: false,
        port: null,
        error:
          error?.code === "EADDRINUSE"
            ? `Port ${config.port} is already used by another program`
            : error?.message || String(error),
      };
      logger.warn?.("[local-api] Could not start:", state.error);
    }
  }

  function describe() {
    return {
      enabled: config?.enabled === true,
      port: config?.port ?? null,
      token: config?.token ?? null,
      feeds: config?.feeds === true,
      filePath: localApiConfigPath(getDataDir()),
      running: state.running,
      error: state.error,
      lastRead,
    };
  }

  return {
    /** Reads the file and, if switched on, starts listening. */
    async start() {
      config = await readLocalApiConfig(getDataDir());
      await apply();
      return describe();
    },
    async update(change) {
      const { enabled, port, feeds } = validateLocalApiChange(change);
      config = await writeLocalApiConfig(getDataDir(), {
        ...(config || {}),
        enabled,
        port,
        feeds: feeds === undefined ? config?.feeds === true : feeds,
        token: config?.token || newLocalApiToken(),
      });
      await apply();
      return describe();
    },
    /** A new token; apps holding the old one are refused from now on. */
    async renewToken() {
      config = await writeLocalApiConfig(getDataDir(), {
        ...(config || {}),
        token: newLocalApiToken(),
      });
      return describe();
    },
    describe,
    /** Whether apps may follow saved views now (view-feeds.md). */
    feedsEnabled: () => config?.enabled === true && config?.feeds === true,
    stop: () => server.stop(),
  };
}

module.exports = { createLocalApiService };
