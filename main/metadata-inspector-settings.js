const METADATA_INSPECTOR_MODES = Object.freeze({
  FLOATING: "floating",
  DOCKED: "docked",
});

// Details docks in the sidebar by default (UX redesign D1); floating is the
// option.
const normalizeMetadataInspectorMode = (value) =>
  value === METADATA_INSPECTOR_MODES.FLOATING
    ? METADATA_INSPECTOR_MODES.FLOATING
    : METADATA_INSPECTOR_MODES.DOCKED;

// Settings written before D1 hold "floating" because it was the default, not
// because anyone chose it. Revision 1 moves them to docked once; a later
// choice of floating is saved with the revision and sticks.
const METADATA_INSPECTOR_REVISION = 1;

const resolveMetadataInspectorMode = (source) =>
  Number(source?.metadataInspectorRevision) >= METADATA_INSPECTOR_REVISION
    ? normalizeMetadataInspectorMode(source.metadataInspectorMode)
    : METADATA_INSPECTOR_MODES.DOCKED;

module.exports = {
  METADATA_INSPECTOR_MODES,
  METADATA_INSPECTOR_REVISION,
  normalizeMetadataInspectorMode,
  resolveMetadataInspectorMode,
};
