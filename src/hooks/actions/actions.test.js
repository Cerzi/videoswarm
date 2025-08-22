import { describe, test, expect, vi, beforeEach } from 'vitest';
import { actionRegistry, ActionIds } from './actions';

describe('actionRegistry', () => {
  let electronAPI;
  let notify;
  let confirm;

  beforeEach(() => {
    electronAPI = {
      openInExternalPlayer: vi.fn(async () => ({ success: true })),
      copyToClipboard:     vi.fn(async () => ({ success: true })),
      showItemInFolder:    vi.fn(async () => ({ success: true })),
      moveToTrash:         vi.fn(async () => ({ success: true })),
    };
    notify = vi.fn();
    confirm = vi.fn(() => true);
  });

  test('copy-path concatenates and uses electron clipboard when available', async () => {
    const videos = [
      { id: '1', name: 'a.mp4', fullPath: '/a.mp4' },
      { id: '2', name: 'b.mp4', fullPath: '/b.mp4' },
    ];
    await actionRegistry[ActionIds.COPY_PATH](videos, { electronAPI, notify });
    expect(electronAPI.copyToClipboard).toHaveBeenCalledWith('/a.mp4\n/b.mp4');
    expect(notify).toHaveBeenCalled();
  });

  test('open-external calls electron open for each playable item', async () => {
    const videos = [
      { id: '1', name: 'a', fullPath: '/a.mp4', isElectronFile: true },
      { id: '2', name: 'b', fullPath: '/b.mp4', isElectronFile: true },
    ];
    await actionRegistry[ActionIds.OPEN_EXTERNAL](videos, { electronAPI, notify });
    expect(electronAPI.openInExternalPlayer).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  test('move-to-trash asks confirm and calls API', async () => {
    const videos = [{ id: '1', name: 'x', fullPath: '/x', isElectronFile: true }];
    await actionRegistry[ActionIds.MOVE_TO_TRASH](videos, { electronAPI, notify, confirm });
    expect(confirm).toHaveBeenCalled();
    expect(electronAPI.moveToTrash).toHaveBeenCalledWith('/x');
    expect(notify).toHaveBeenCalled();
  });
});
