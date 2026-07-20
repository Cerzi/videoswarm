const METADATA_INSPECTOR_MODES = Object.freeze({
  FLOATING: "floating",
  DOCKED: "docked",
});

const normalizeMetadataInspectorMode = (value) =>
  value === METADATA_INSPECTOR_MODES.DOCKED
    ? METADATA_INSPECTOR_MODES.DOCKED
    : METADATA_INSPECTOR_MODES.FLOATING;

module.exports = {
  METADATA_INSPECTOR_MODES,
  normalizeMetadataInspectorMode,
};
