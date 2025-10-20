let capturedMetaEnv;
try {
  // eslint-disable-next-line no-undef
  capturedMetaEnv = import.meta?.env;
} catch {
  capturedMetaEnv = undefined;
}

const capturedProcessEnv =
  (typeof process !== "undefined" && process?.env) || undefined;

export const resolveFeatureFlags = ({ processEnv, metaEnv } = {}) => {
  const env = {
    ...(metaEnv || {}),
    ...(processEnv || {}),
  };

  const isEnabled = (key) => {
    const value = env?.[key];
    if (value == null) return false;
    if (value === true) return true;
    if (value === false) return false;
    if (typeof value === "string") {
      const normalized = value.toLowerCase();
      return normalized === "1" || normalized === "true" || normalized === "yes";
    }
    return Boolean(value);
  };

  return {
    stableViewAnchoring: true,
    stableViewFixes: true,
    experimentalLayoutProjection:
      isEnabled("VS_EXP_LPM") || isEnabled("VITE_VS_EXP_LPM"),
  };
};

export const feature = resolveFeatureFlags({
  processEnv: capturedProcessEnv,
  metaEnv: capturedMetaEnv,
});

export default feature;
