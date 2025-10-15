export function getMetadataPanelToggleState(isOpen, selectionSize) {
  if (isOpen) {
    if (selectionSize > 0) {
      return { nextOpen: false, shouldClear: true };
    }
    return { nextOpen: false, shouldClear: false };
  }

  if (selectionSize === 0) {
    return { nextOpen: false, shouldClear: false };
  }

  return { nextOpen: true, shouldClear: false };
}

export function shouldAutoOpenMetadataPanel(selectionSize, isOpen) {
  return selectionSize > 0 && !isOpen;
}
