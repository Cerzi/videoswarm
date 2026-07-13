import React, { useMemo } from "react";
import LoadingProgress from "../../components/LoadingProgress";

function LoadingOverlay({
  show,
  status,
  stage,
  progress,
  memoryStatus,
  onCancel,
}) {
  const resolvedStatus = useMemo(() => {
    if (status) return status;
    const numericProgress = Number(progress);
    const hasProgress = Number.isFinite(numericProgress);
    return {
      phase: hasProgress ? "indexing" : "preparing",
      message: stage || "Preparing folder scan",
      completed: hasProgress ? numericProgress : null,
      total: hasProgress ? 100 : null,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
  }, [progress, stage, status]);

  if (!show) return null;
  return (
    <LoadingProgress
      status={resolvedStatus}
      memoryStatus={memoryStatus}
      onCancel={onCancel}
    />
  );
}

export default LoadingOverlay;
