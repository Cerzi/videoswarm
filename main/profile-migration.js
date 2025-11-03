const fs = require("fs");
const path = require("path");

const fsp = fs.promises;

async function pathExists(targetPath) {
  if (!targetPath) {
    return false;
  }
  try {
    await fsp.stat(targetPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function copyFileIfMissing(sourcePath, destinationPath) {
  if (!sourcePath || !destinationPath) {
    return false;
  }
  if (!(await pathExists(sourcePath))) {
    return false;
  }
  if (await pathExists(destinationPath)) {
    return false;
  }

  await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
  await fsp.copyFile(sourcePath, destinationPath);
  return true;
}

async function copyDirectoryContents(sourceDir, destinationDir) {
  if (!sourceDir || !destinationDir) {
    return false;
  }
  if (!(await pathExists(sourceDir))) {
    return false;
  }

  const stats = await fsp.stat(sourceDir);
  if (!stats.isDirectory()) {
    return false;
  }

  await fsp.mkdir(destinationDir, { recursive: true });
  let copiedAny = false;
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);

    if (entry.isDirectory()) {
      const copied = await copyDirectoryContents(sourcePath, destinationPath);
      copiedAny = copiedAny || copied;
      continue;
    }

    const isFile = typeof entry.isFile === "function" && entry.isFile();
    const isSymlink =
      typeof entry.isSymbolicLink === "function" && entry.isSymbolicLink();
    if (!isFile && !isSymlink) {
      continue;
    }

    if (await pathExists(destinationPath)) {
      continue;
    }

    await fsp.copyFile(sourcePath, destinationPath);
    copiedAny = true;
  }

  return copiedAny;
}

async function migrateLegacyProfileData({
  profileId,
  profilePath,
  userDataPath,
  defaultProfileId = "default",
} = {}) {
  const summary = {
    copiedFiles: [],
    copiedDirectories: [],
  };

  if (!profileId || !profilePath || !userDataPath) {
    return summary;
  }

  if (profileId !== defaultProfileId) {
    return summary;
  }

  const resolvedUserData = path.resolve(userDataPath);
  const resolvedProfilePath = path.resolve(profilePath);
  if (resolvedUserData === resolvedProfilePath) {
    return summary;
  }

  if (!(await pathExists(resolvedUserData))) {
    return summary;
  }

  const dbBaseName = "videoswarm-meta.db";
  const dbCandidates = [
    dbBaseName,
    `${dbBaseName}-wal`,
    `${dbBaseName}-shm`,
    `${dbBaseName}-journal`,
  ];

  for (const fileName of dbCandidates) {
    const sourceFile = path.join(resolvedUserData, fileName);
    const destinationFile = path.join(resolvedProfilePath, fileName);
    try {
      const copied = await copyFileIfMissing(sourceFile, destinationFile);
      if (copied) {
        summary.copiedFiles.push(destinationFile);
      }
    } catch (error) {
      console.warn(`[profile-migration] Failed to copy ${fileName}`, error);
    }
  }

  const recentFileName = "recent-folders.json";
  try {
    const copied = await copyFileIfMissing(
      path.join(resolvedUserData, recentFileName),
      path.join(resolvedProfilePath, recentFileName)
    );
    if (copied) {
      summary.copiedFiles.push(path.join(resolvedProfilePath, recentFileName));
    }
  } catch (error) {
    console.warn("[profile-migration] Failed to copy recent folders", error);
  }

  try {
    const copiedThumbs = await copyDirectoryContents(
      path.join(resolvedUserData, "thumbs"),
      path.join(resolvedProfilePath, "thumbs")
    );
    if (copiedThumbs) {
      summary.copiedDirectories.push(path.join(resolvedProfilePath, "thumbs"));
    }
  } catch (error) {
    console.warn("[profile-migration] Failed to copy thumbnails", error);
  }

  return summary;
}

module.exports = {
  migrateLegacyProfileData,
  // Exported for testing
  __internal: {
    pathExists,
    copyFileIfMissing,
    copyDirectoryContents,
  },
};
