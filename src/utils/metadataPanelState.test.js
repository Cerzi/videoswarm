import { describe, it, expect } from 'vitest';
import { shouldAutoOpenMetadataPanel } from './metadataPanelState';

describe('metadataPanelState', () => {
  describe('shouldAutoOpenMetadataPanel', () => {
    it('returns true when there is a selection and the panel is closed', () => {
      expect(shouldAutoOpenMetadataPanel(1, false)).toBe(true);
    });

    it('returns false when there is no selection', () => {
      expect(shouldAutoOpenMetadataPanel(0, false)).toBe(false);
    });

    it('returns false when the panel is already open', () => {
      expect(shouldAutoOpenMetadataPanel(2, true)).toBe(false);
    });
  });
});
