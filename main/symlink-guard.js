const { promises: defaultFsPromises } = require("fs");

// A symbolic link is fingerprint-identical to its target, so indexing one
// would show the same content twice with shared tags, rating and review
// state. Directory and polling scans already skip links because they classify
// entries with Dirent; this gives the native watcher the same rule. See
// docs/architecture/generation-versions.md, Section 7.
function withSymlinkGuard(createVideoFileObject, fsPromises = defaultFsPromises) {
  return async function createNonLinkVideoFileObject(filePath, ...rest) {
    let stats = null;
    try {
      stats = await fsPromises.lstat(filePath);
    } catch {
      // A missing or unreadable path is the record builder's to report.
    }
    if (stats?.isSymbolicLink?.()) return null;
    return createVideoFileObject(filePath, ...rest);
  };
}

module.exports = { withSymlinkGuard };
