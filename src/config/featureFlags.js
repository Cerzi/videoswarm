const truthy = (value) => {
  if (value === true) return true;
  if (value === false) return false;
  if (value == null) return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return false;
    return normalized === "1" || normalized === "true" || normalized === "yes";
  }
  return Boolean(value);
};

export const resolveFeatureFlags = ({ processEnv = {}, metaEnv = {} } = {}) => {
  const env = { ...metaEnv, ...processEnv };

  const keepWindowing =
    truthy(env.VS_KEEP_WINDOWING) || truthy(env.VITE_VS_KEEP_WINDOWING);
  const enableDeWindow =
    truthy(env.VS_DEWINDOW) || truthy(env.VITE_VS_DEWINDOW);

  return {
    stableViewAnchoring: true,
    stableViewFixes: true,
    fullDomMasonry: keepWindowing ? false : enableDeWindow || true,
  };
};

let capturedProcessEnv = {};
try {
  if (typeof process !== "undefined" && process?.env) {
    capturedProcessEnv = process.env;
  }
} catch {
  capturedProcessEnv = {};
}

let capturedMetaEnv = {};
try {
  // eslint-disable-next-line no-undef
  capturedMetaEnv = import.meta && import.meta.env ? import.meta.env : {};
} catch {
  capturedMetaEnv = {};
}

export const feature = resolveFeatureFlags({
  processEnv: capturedProcessEnv,
  metaEnv: capturedMetaEnv,
});

const resolvedNodeEnv =
  typeof process !== "undefined" ? process.env?.NODE_ENV : undefined;

if (
  typeof window !== "undefined" &&
  typeof console !== "undefined" &&
  resolvedNodeEnv !== "test"
) {
  console.info(
    "[features] fullDomMasonry =",
    feature.fullDomMasonry,
    "(VS_DEWINDOW =",
    capturedProcessEnv?.VS_DEWINDOW,
    ", VITE_VS_DEWINDOW =",
    capturedMetaEnv?.VITE_VS_DEWINDOW,
    ", VS_KEEP_WINDOWING =",
    capturedProcessEnv?.VS_KEEP_WINDOWING,
    ", VITE_VS_KEEP_WINDOWING =",
    capturedMetaEnv?.VITE_VS_KEEP_WINDOWING,
    ")"
  );
}

export default feature;
