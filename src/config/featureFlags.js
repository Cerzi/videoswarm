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

  return {
    stableViewAnchoring: true,
    stableViewFixes: true,
    experimentalLayoutProjection:
      truthy(env.VS_EXP_LPM) || truthy(env.VITE_VS_EXP_LPM),
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
    "[features] experimentalLayoutProjection =",
    feature.experimentalLayoutProjection,
    "(VS_EXP_LPM =",
    capturedProcessEnv?.VS_EXP_LPM,
    ", VITE_VS_EXP_LPM =",
    capturedMetaEnv?.VITE_VS_EXP_LPM,
    ")"
  );
}

export default feature;
