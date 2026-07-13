import React from "react";
import LoadingProgress from "../../components/LoadingProgress";

function LoadingOverlay({ show, stage, progress, onCancel }) {
  if (!show) return null;
  return (
    <LoadingProgress
      progress={{
        current: typeof progress === "number" ? progress : 0,
        total: 100,
        stage: stage || "",
      }}
      onCancel={onCancel}
    />
  );
}

export default LoadingOverlay;
