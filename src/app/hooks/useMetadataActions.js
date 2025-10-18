import { useCallback } from "react";
import { normalizeVideoFromMain } from "../videoNormalization";

export function useMetadataActions({
  selectedFingerprints,
  setVideos,
  setAvailableTags,
  notify,
}) {
  const applyMetadataPatch = useCallback((updates) => {
    if (!updates || typeof updates !== "object") return;
    setVideos((prev) =>
      prev.map((video) => {
        const fingerprint = video?.fingerprint;
        if (!fingerprint || !updates[fingerprint]) return video;
        return normalizeVideoFromMain({
          ...video,
          ...updates[fingerprint],
          fingerprint,
        });
      })
    );
  }, [setVideos]);

  const handleAddTags = useCallback(
    async (tagNames) => {
      const api = window.electronAPI?.metadata;
      if (!api?.addTags) return;
      const fingerprints = selectedFingerprints;
      if (!fingerprints.length) return;
      const cleanNames = Array.isArray(tagNames)
        ? tagNames.map((name) => name.trim()).filter(Boolean)
        : [];
      if (!cleanNames.length) return;
      try {
        const result = await api.addTags(fingerprints, cleanNames);
        if (result?.updates) applyMetadataPatch(result.updates);
        if (Array.isArray(result?.tags)) setAvailableTags(result.tags);
        notify(
          `Added ${cleanNames.join(", ")} to ${fingerprints.length} item(s)`,
          "success"
        );
      } catch (error) {
        console.error("Failed to add tags:", error);
        notify("Failed to add tags", "error");
      }
    },
    [selectedFingerprints, applyMetadataPatch, setAvailableTags, notify]
  );

  const handleRemoveTag = useCallback(
    async (tagName) => {
      const api = window.electronAPI?.metadata;
      if (!api?.removeTag) return;
      const fingerprints = selectedFingerprints;
      const cleanName = (tagName ?? "").trim();
      if (!fingerprints.length || !cleanName) return;
      try {
        const result = await api.removeTag(fingerprints, cleanName);
        if (result?.updates) applyMetadataPatch(result.updates);
        if (Array.isArray(result?.tags)) setAvailableTags(result.tags);
        notify(
          `Removed "${cleanName}" from ${fingerprints.length} item(s)`,
          "success"
        );
      } catch (error) {
        console.error("Failed to remove tag:", error);
        notify("Failed to remove tag", "error");
      }
    },
    [selectedFingerprints, applyMetadataPatch, setAvailableTags, notify]
  );

  const handleSetRating = useCallback(
    async (value, targetFingerprints = selectedFingerprints) => {
      const api = window.electronAPI?.metadata;
      if (!api?.setRating) return;
      const fingerprints = (targetFingerprints || []).filter(Boolean);
      if (!fingerprints.length) return;
      try {
        const result = await api.setRating(fingerprints, value);
        if (result?.updates) applyMetadataPatch(result.updates);
        if (value === null || value === undefined) {
          notify(`Cleared rating for ${fingerprints.length} item(s)`, "success");
        } else {
          const safeRating = Math.max(0, Math.min(5, Math.round(Number(value))));
          notify(
            `Rated ${fingerprints.length} item(s) ${safeRating} star${
              safeRating === 1 ? "" : "s"
            }`,
            "success"
          );
        }
      } catch (error) {
        console.error("Failed to update rating:", error);
        notify("Failed to update rating", "error");
      }
    },
    [selectedFingerprints, applyMetadataPatch, notify]
  );

  const handleClearRating = useCallback(() => {
    handleSetRating(null, selectedFingerprints);
  }, [handleSetRating, selectedFingerprints]);

  const handleApplyExistingTag = useCallback(
    (tagName) => handleAddTags([tagName]),
    [handleAddTags]
  );

  const refreshTagList = useCallback(async () => {
    const api = window.electronAPI?.metadata;
    if (!api?.listTags) return;
    try {
      const res = await api.listTags();
      if (Array.isArray(res?.tags)) {
        setAvailableTags(res.tags);
      }
    } catch (error) {
      console.warn("Failed to refresh tags:", error);
    }
  }, [setAvailableTags]);

  return {
    applyMetadataPatch,
    handleAddTags,
    handleRemoveTag,
    handleSetRating,
    handleClearRating,
    handleApplyExistingTag,
    refreshTagList,
  };
}
