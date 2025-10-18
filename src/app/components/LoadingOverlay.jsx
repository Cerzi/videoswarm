import LoadingProgress from "../../components/LoadingProgress";

function LoadingOverlay({ show, stage, progress }) {
  if (!show) return null;
  return (
    <LoadingProgress
      progress={{
        current: typeof progress === "number" ? progress : 0,
        total: 100,
        stage: stage || "",
      }}
    />
  );
}

export default LoadingOverlay;
