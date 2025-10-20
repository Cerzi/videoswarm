let metaEnv;
try {
  // eslint-disable-next-line no-undef
  metaEnv = import.meta?.env;
} catch {
  metaEnv = undefined;
}

const env =
  (typeof process !== "undefined" && process?.env) ||
  metaEnv ||
  {};

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

export const feature = {
  stableViewAnchoring: true,
  stableViewFixes: true,
  experimentalLayoutProjection:
    isEnabled("VS_EXP_LPM") || isEnabled("VITE_VS_EXP_LPM"),
};

export default feature;
