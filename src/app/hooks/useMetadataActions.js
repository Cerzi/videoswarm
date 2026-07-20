import { useCallback, useRef } from "react";
import { normalizeVideoFromMain } from "../videoNormalization";
import {
  normalizeReviewState,
  reviewStateLabel,
} from "../../review/reviewState";

export function useMetadataActions({
  selectedFingerprints,
  setVideos,
  setAvailableTags,
  notify,
  ownershipKey,
}) {
  const ownershipKeyRef = useRef(ownershipKey);
  ownershipKeyRef.current = ownershipKey;

  const completionIsCurrent = useCallback((requestedOwnership, guard) => {
    if (!Object.is(ownershipKeyRef.current, requestedOwnership)) return false;
    if (typeof guard !== "function") return true;
    try {
      return guard() === true;
    } catch {
      return false;
    }
  }, []);

  const staleSuccess = useCallback((result) => ({
    success: true,
    stale: true,
    updates: result?.updates || {},
    result,
  }), []);

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
    async (
      tagNames,
      targetFingerprints = selectedFingerprints,
      { completionGuard = null } = {}
    ) => {
      const requestedOwnership = ownershipKeyRef.current;
      const api = window.electronAPI?.metadata;
      if (!api?.addTags) {
        return { success: false, error: "Tag service is unavailable" };
      }
      const fingerprints = (targetFingerprints || []).filter(Boolean);
      if (!fingerprints.length) {
        return { success: false, error: "No taggable clips selected" };
      }
      const cleanNames = Array.isArray(tagNames)
        ? tagNames.map((name) => name.trim()).filter(Boolean)
        : [];
      if (!cleanNames.length) {
        return { success: false, error: "No valid tags supplied" };
      }
      try {
        const result = await api.addTags(fingerprints, cleanNames);
        if (result?.error) throw new Error(result.error);
        if (!completionIsCurrent(requestedOwnership, completionGuard)) {
          return staleSuccess(result);
        }
        if (result?.updates) applyMetadataPatch(result.updates);
        if (Array.isArray(result?.tags)) setAvailableTags(result.tags);
        notify(
          `Added ${cleanNames.join(", ")} to ${fingerprints.length} item(s)`,
          "success"
        );
        return { success: true, updates: result?.updates || {}, result };
      } catch (error) {
        if (!completionIsCurrent(requestedOwnership, completionGuard)) {
          return { success: false, stale: true, error };
        }
        console.error("Failed to add tags:", error);
        notify("Failed to add tags", "error");
        return { success: false, error };
      }
    },
    [
      selectedFingerprints,
      applyMetadataPatch,
      completionIsCurrent,
      setAvailableTags,
      staleSuccess,
      notify,
    ]
  );

  const handleRemoveTag = useCallback(
    async (
      tagName,
      targetFingerprints = selectedFingerprints,
      { completionGuard = null } = {}
    ) => {
      const requestedOwnership = ownershipKeyRef.current;
      const api = window.electronAPI?.metadata;
      if (!api?.removeTag) {
        return { success: false, error: "Tag service is unavailable" };
      }
      const fingerprints = (targetFingerprints || []).filter(Boolean);
      const cleanName = (tagName ?? "").trim();
      if (!fingerprints.length || !cleanName) {
        return { success: false, error: "No valid tag target supplied" };
      }
      try {
        const result = await api.removeTag(fingerprints, cleanName);
        if (result?.error) throw new Error(result.error);
        if (!completionIsCurrent(requestedOwnership, completionGuard)) {
          return staleSuccess(result);
        }
        if (result?.updates) applyMetadataPatch(result.updates);
        if (Array.isArray(result?.tags)) setAvailableTags(result.tags);
        notify(
          `Removed "${cleanName}" from ${fingerprints.length} item(s)`,
          "success"
        );
        return { success: true, updates: result?.updates || {}, result };
      } catch (error) {
        if (!completionIsCurrent(requestedOwnership, completionGuard)) {
          return { success: false, stale: true, error };
        }
        console.error("Failed to remove tag:", error);
        notify("Failed to remove tag", "error");
        return { success: false, error };
      }
    },
    [
      selectedFingerprints,
      applyMetadataPatch,
      completionIsCurrent,
      setAvailableTags,
      staleSuccess,
      notify,
    ]
  );

  const handleSetRating = useCallback(
    async (
      value,
      targetFingerprints = selectedFingerprints,
      { quiet = false, completionGuard = null } = {}
    ) => {
      const requestedOwnership = ownershipKeyRef.current;
      const api = window.electronAPI?.metadata;
      if (!api?.setRating) {
        return { success: false, error: "Rating service is unavailable" };
      }
      const fingerprints = (targetFingerprints || []).filter(Boolean);
      if (!fingerprints.length) {
        return { success: false, error: "No reviewable clips selected" };
      }
      try {
        const result = await api.setRating(fingerprints, value);
        if (result?.error) {
          throw new Error(result.error);
        }
        if (!completionIsCurrent(requestedOwnership, completionGuard)) {
          return staleSuccess(result);
        }
        if (result?.updates) applyMetadataPatch(result.updates);
        if (!quiet && (value === null || value === undefined)) {
          notify(`Cleared rating for ${fingerprints.length} item(s)`, "success");
        } else if (!quiet) {
          const safeRating = Math.max(0, Math.min(5, Math.round(Number(value))));
          notify(
            `Rated ${fingerprints.length} item(s) ${safeRating} star${
              safeRating === 1 ? "" : "s"
            }`,
            "success"
          );
        }
        return {
          success: true,
          updates: result?.updates || {},
          result,
        };
      } catch (error) {
        if (!completionIsCurrent(requestedOwnership, completionGuard)) {
          return { success: false, stale: true, error };
        }
        console.error("Failed to update rating:", error);
        notify("Failed to update rating", "error");
        return { success: false, error };
      }
    },
    [
      selectedFingerprints,
      applyMetadataPatch,
      completionIsCurrent,
      staleSuccess,
      notify,
    ]
  );

  const handleClearRating = useCallback(() => {
    return handleSetRating(null, selectedFingerprints);
  }, [handleSetRating, selectedFingerprints]);

  const handleSetReviewState = useCallback(
    async (
      value,
      targetFingerprints = selectedFingerprints,
      { quiet = false, completionGuard = null } = {}
    ) => {
      const requestedOwnership = ownershipKeyRef.current;
      const api = window.electronAPI?.metadata;
      if (!api?.setReviewState) {
        return { success: false, error: "Review service is unavailable" };
      }
      const fingerprints = (targetFingerprints || []).filter(Boolean);
      if (!fingerprints.length) {
        return { success: false, error: "No reviewable clips selected" };
      }
      const reviewState = normalizeReviewState(value);

      try {
        const result = await api.setReviewState(fingerprints, reviewState);
        if (result?.error) {
          throw new Error(result.error);
        }
        if (!completionIsCurrent(requestedOwnership, completionGuard)) {
          return staleSuccess(result);
        }
        if (result?.updates) applyMetadataPatch(result.updates);
        if (!quiet) {
          notify(
            `Marked ${fingerprints.length} item(s) ${reviewStateLabel(reviewState).toLowerCase()}`,
            "success"
          );
        }
        return {
          success: true,
          updates: result?.updates || {},
          result,
        };
      } catch (error) {
        if (!completionIsCurrent(requestedOwnership, completionGuard)) {
          return { success: false, stale: true, error };
        }
        console.error("Failed to update review state:", error);
        notify("Failed to update review state", "error");
        return { success: false, error };
      }
    },
    [
      selectedFingerprints,
      applyMetadataPatch,
      completionIsCurrent,
      staleSuccess,
      notify,
    ]
  );

  const handleRestoreReviewMetadata = useCallback(
    async (snapshots, { completionGuard = null } = {}) => {
      const requestedOwnership = ownershipKeyRef.current;
      const api = window.electronAPI?.metadata;
      if (!api?.restoreReview) {
        return { success: false, error: "Review restore service is unavailable" };
      }

      const cleanSnapshots = (Array.isArray(snapshots) ? snapshots : [])
        .filter((snapshot) => snapshot?.fingerprint)
        .map((snapshot) => ({
          fingerprint: snapshot.fingerprint,
          reviewState: normalizeReviewState(snapshot.reviewState),
          rating:
            typeof snapshot.rating === "number" &&
            Number.isFinite(snapshot.rating)
              ? snapshot.rating
              : null,
        }));
      if (!cleanSnapshots.length) {
        return { success: false, error: "No review metadata to restore" };
      }

      try {
        const result = await api.restoreReview(cleanSnapshots);
        if (result?.error) {
          throw new Error(result.error);
        }
        if (!completionIsCurrent(requestedOwnership, completionGuard)) {
          return staleSuccess(result);
        }
        if (result?.updates) applyMetadataPatch(result.updates);
        return {
          success: true,
          updates: result?.updates || {},
          result,
        };
      } catch (error) {
        if (!completionIsCurrent(requestedOwnership, completionGuard)) {
          return { success: false, stale: true, error };
        }
        console.error("Failed to restore review metadata:", error);
        notify("Failed to undo review change", "error");
        return { success: false, error };
      }
    },
    [applyMetadataPatch, completionIsCurrent, staleSuccess, notify]
  );

  const handleApplyExistingTag = useCallback(
    (tagName, targetFingerprints = selectedFingerprints, options) =>
      handleAddTags([tagName], targetFingerprints, options),
    [handleAddTags, selectedFingerprints]
  );

  const refreshTagList = useCallback(async () => {
    const requestedOwnership = ownershipKeyRef.current;
    const api = window.electronAPI?.metadata;
    if (!api?.listTags) return;
    try {
      const res = await api.listTags();
      if (
        Object.is(ownershipKeyRef.current, requestedOwnership) &&
        Array.isArray(res?.tags)
      ) {
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
    handleSetReviewState,
    handleRestoreReviewMetadata,
    handleApplyExistingTag,
    refreshTagList,
  };
}
