import { useEffect, useRef, useState } from "react";
import {
  dropContainsDirectory,
  extractDroppedPaths,
} from "../drag-drop/extractDroppedPaths";

const NO_DIRECTORY_MESSAGE =
  "Dropped items didn't contain a folder. Drop a folder to open it.";
const NO_PATHS_MESSAGE =
  "We couldn't read that drop. Drop a folder to open it.";
const PLATFORM_PATH_WARNING = {
  win32:
    "Windows didn't share the folder's location with VideoSwarm, so we couldn't open it automatically. Please use Open Folder and pick it manually.",
  linux:
    "Your file manager didn't share the folder's location with VideoSwarm, so we couldn't open it automatically. Please use Open Folder and pick it manually.",
};

function missingPathMessage(platform = "unknown") {
  if (platform && PLATFORM_PATH_WARNING[platform]) {
    return PLATFORM_PATH_WARNING[platform];
  }
  return "Your system didn't share the folder's location with VideoSwarm, so we couldn't open it automatically. Please use Open Folder and pick it manually.";
}

function hasFilePayload(event) {
  const types = event?.dataTransfer?.types;
  if (!types) {
    return false;
  }

  if (typeof types.includes === "function") {
    return types.includes("Files");
  }

  try {
    return Array.from(types).includes("Files");
  } catch (error) {
    console.warn("Failed to inspect drag types", error);
    return false;
  }
}

export function useDroppedFolderOpener({ notify }) {
  const [isDragActive, setIsDragActive] = useState(false);
  const dragCounterRef = useRef(0);

  useEffect(() => {
    const electronAPI = window?.electronAPI;
    if (!electronAPI?.openDroppedFolder) {
      return undefined;
    }

    const platform = electronAPI.platform || navigator?.platform || "unknown";

    const resetDragState = () => {
      dragCounterRef.current = 0;
      setIsDragActive(false);
    };

    const handleDragEnter = (event) => {
      if (!hasFilePayload(event)) {
        return;
      }
      dragCounterRef.current += 1;
      event.preventDefault();
      setIsDragActive(true);
    };

    const handleDragOver = (event) => {
      if (!hasFilePayload(event)) {
        return;
      }
      event.preventDefault();
      try {
        event.dataTransfer.dropEffect = "copy";
      } catch (error) {
        // Ignore dropEffect assignment issues
      }
    };

    const handleDragLeave = (event) => {
      if (!hasFilePayload(event)) {
        return;
      }
      event.preventDefault();
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
      if (dragCounterRef.current <= 0 || !event.relatedTarget) {
        resetDragState();
      }
    };

    const handleDrop = async (event) => {
      if (!hasFilePayload(event)) {
        return;
      }

      event.preventDefault();
      const containsDirectory = dropContainsDirectory(event);
      const droppedPaths = extractDroppedPaths(event, platform);
      resetDragState();

      if (!droppedPaths.length) {
        if (containsDirectory) {
          notify?.(missingPathMessage(platform), "warning");
          const selectFolder = electronAPI.selectFolder;
          if (typeof selectFolder === "function") {
            try {
              const selection = await selectFolder();
              if (selection?.success && selection.folderPath) {
                const fallbackResult = await electronAPI.openDroppedFolder({
                  paths: [selection.folderPath],
                  source: "drop-fallback",
                });
                if (!fallbackResult?.success) {
                  if (fallbackResult?.reason === "NO_DIRECTORY") {
                    notify?.(NO_DIRECTORY_MESSAGE, "info");
                  } else if (fallbackResult?.reason === "NO_PATHS") {
                    notify?.(missingPathMessage(platform), "warning");
                  } else if (fallbackResult?.error) {
                    notify?.(fallbackResult.error, "error");
                  } else {
                    notify?.("Failed to open folder", "error");
                  }
                }
              }
            } catch (fallbackError) {
              console.error(
                "Failed to open folder through fallback picker",
                fallbackError
              );
              notify?.("Failed to open folder", "error");
            }
          }
        } else {
          notify?.(NO_PATHS_MESSAGE, "info");
        }
        return;
      }

      try {
        const result = await electronAPI.openDroppedFolder({
          paths: droppedPaths,
          source: "drop",
        });
        if (result?.success) {
          if (typeof result?.infoMessage === "string" && result.infoMessage) {
            notify?.(result.infoMessage, result.infoType || "info");
          }
          return;
        }

        if (result?.reason === "NO_DIRECTORY") {
          notify?.(NO_DIRECTORY_MESSAGE, "info");
        } else if (result?.reason === "NO_PATHS") {
          notify?.(missingPathMessage(platform), "warning");
        } else if (result?.error) {
          notify?.(result.error, "error");
        } else {
          notify?.("Failed to open folder", "error");
        }
      } catch (error) {
        console.error("Failed to open dropped folder", error);
        notify?.("Failed to open folder", "error");
      }
    };

    const handleDragEnd = () => {
      resetDragState();
    };

    window.addEventListener("dragenter", handleDragEnter);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("drop", handleDrop);
    window.addEventListener("dragend", handleDragEnd);

    return () => {
      window.removeEventListener("dragenter", handleDragEnter);
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("drop", handleDrop);
      window.removeEventListener("dragend", handleDragEnd);
    };
  }, [notify]);

  return isDragActive;
}

export default useDroppedFolderOpener;
