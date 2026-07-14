export function requireSqliteSuite(describeFunction, loadError) {
  if (!loadError) return describeFunction;

  if (process.env.VIDEOSWARM_REQUIRE_SQLITE_TESTS === "1") {
    const message = loadError?.message || String(loadError);
    throw new Error(
      `SQLite integration tests are mandatory in this runtime, but better-sqlite3 could not load: ${message}`,
      { cause: loadError }
    );
  }

  return describeFunction.skip;
}
