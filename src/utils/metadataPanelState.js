export function shouldAutoOpenMetadataPanel(selectionSize, isOpen) {
  return selectionSize > 0 && !isOpen;
}
