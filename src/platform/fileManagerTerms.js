// What the operating system calls its file manager and its bin, so file
// actions read the way the rest of the desktop does.

export function currentPlatform() {
  try {
    return window?.electronAPI?.platform || "";
  } catch {
    return "";
  }
}

export function trashName(platform = currentPlatform()) {
  return platform === "win32" ? "Recycle Bin" : "Trash";
}

export function fileManagerName(platform = currentPlatform()) {
  if (platform === "win32") return "Explorer";
  if (platform === "darwin") return "Finder";
  return "File Manager";
}

export const moveToTrashLabel = (platform) => `Move to ${trashName(platform)}`;
export const showInFileManagerLabel = (platform) => `Show in ${fileManagerName(platform)}`;
