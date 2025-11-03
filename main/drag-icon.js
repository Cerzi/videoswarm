const EMBEDDED_DRAG_ICON_BASE64 =
  "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" +
  "v/agShM12xkAAAAASUVORK5CYII=";

let cachedIcon = null;

const createEmptyIcon = (nativeImage) => {
  if (!nativeImage) return null;
  if (typeof nativeImage.createEmpty === "function") {
    return nativeImage.createEmpty();
  }
  if (typeof nativeImage.createFromBuffer === "function") {
    try {
      return nativeImage.createFromBuffer(Buffer.alloc(0));
    } catch (error) {
      console.warn("Failed to create empty native drag icon:", error);
    }
  }
  return null;
};

const createEmbeddedDragIcon = (nativeImage) => {
  if (!nativeImage || typeof nativeImage.createFromBuffer !== "function") {
    return createEmptyIcon(nativeImage);
  }

  try {
    let icon = nativeImage.createFromBuffer(
      Buffer.from(EMBEDDED_DRAG_ICON_BASE64, "base64")
    );
    if (icon && !icon.isEmpty() && typeof icon.resize === "function") {
      const resized = icon.resize({ width: 48, height: 48 });
      if (resized && !resized.isEmpty()) {
        icon = resized;
      }
    }
    if (icon && !icon.isEmpty()) {
      return icon;
    }
  } catch (error) {
    console.error("Failed to decode embedded drag icon:", error);
  }

  return createEmptyIcon(nativeImage);
};

const getEmbeddedDragIcon = (nativeImage) => {
  if (!cachedIcon || cachedIcon.isEmpty()) {
    cachedIcon = createEmbeddedDragIcon(nativeImage);
  }
  return cachedIcon;
};

const resetEmbeddedDragIconCache = () => {
  cachedIcon = null;
};

module.exports = {
  getEmbeddedDragIcon,
  resetEmbeddedDragIconCache,
};
