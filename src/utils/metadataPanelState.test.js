import { describe, it, expect } from 'vitest';
import { getMetadataPanelToggleState, shouldAutoOpenMetadataPanel } from './metadataPanelState';

describe('metadataPanelState', () => {
  describe('getMetadataPanelToggleState', () => {
    it('requests clearing selection when collapsing with active selection', () => {
      const result = getMetadataPanelToggleState(true, 3);
      expect(result).toEqual({ nextOpen: false, shouldClear: true });
    });

    it('keeps panel closed when toggled closed without selection', () => {
      const result = getMetadataPanelToggleState(false, 0);
      expect(result).toEqual({ nextOpen: false, shouldClear: false });
    });

    it('opens panel when there is a selection', () => {
      const result = getMetadataPanelToggleState(false, 2);
      expect(result).toEqual({ nextOpen: true, shouldClear: false });
    });

    it('collapsing without selection does not request clearing', () => {
      const result = getMetadataPanelToggleState(true, 0);
      expect(result).toEqual({ nextOpen: false, shouldClear: false });
    });
  });

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
