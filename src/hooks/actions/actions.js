/**
 * Pure action executors keyed by an action id.
 * They operate on an array of *video objects* and injected dependencies.
 * No React here. Easy to unit test.
 */

export const ActionIds = {
    OPEN_EXTERNAL: 'open-external',
    COPY_PATH: 'copy-path',
    COPY_FILENAME: 'copy-filename',
    COPY_RELATIVE_PATH: 'copy-relative-path',
    SHOW_IN_FOLDER: 'show-in-folder',
    FILE_PROPERTIES: 'file-properties',
    MOVE_TO_TRASH: 'move-to-trash',
  };
  
  export const actionRegistry = {
    [ActionIds.OPEN_EXTERNAL]: async (videos, { electronAPI, notify }) => {
      const playable = videos.filter(v => v.isElectronFile && v.fullPath);
      for (const v of playable) {
        const res = await electronAPI?.openInExternalPlayer?.(v.fullPath);
        if (res?.success === false) notify(`Failed to open "${v.name}"`, 'error');
        else notify(`Opened "${v.name}"`, 'success');
      }
    },
  
    [ActionIds.COPY_PATH]: async (videos, { electronAPI, notify }) => {
      const text = videos.map(v => v.fullPath || v.relativePath || v.name).join('\n');
      if (electronAPI?.copyToClipboard) await electronAPI.copyToClipboard(text);
      else if (navigator?.clipboard?.writeText) await navigator.clipboard.writeText(text);
      notify('Path(s) copied to clipboard', 'success');
    },
  
    [ActionIds.COPY_FILENAME]: async (videos, { electronAPI, notify }) => {
      const text = videos.map(v => v.name).join('\n');
      if (electronAPI?.copyToClipboard) await electronAPI.copyToClipboard(text);
      else if (navigator?.clipboard?.writeText) await navigator.clipboard.writeText(text);
      notify('Filename(s) copied to clipboard', 'success');
    },
  
    [ActionIds.COPY_RELATIVE_PATH]: async (videos, { electronAPI, notify }) => {
      const text = videos.map(v => v.relativePath || v.name).join('\n');
      if (electronAPI?.copyToClipboard) await electronAPI.copyToClipboard(text);
      else if (navigator?.clipboard?.writeText) await navigator.clipboard.writeText(text);
      notify('Relative path(s) copied', 'success');
    },
  
    [ActionIds.SHOW_IN_FOLDER]: async (videos, { electronAPI, notify }) => {
      for (const v of videos) {
        if (v.isElectronFile && v.fullPath) {
          const res = await electronAPI?.showItemInFolder?.(v.fullPath);
          if (res?.success === false) notify(`Failed to show "${v.name}"`, 'error');
          else notify(`Opened folder for "${v.name}"`, 'success');
        }
      }
    },
  
    [ActionIds.FILE_PROPERTIES]: async (videos, { /* electronAPI, */ notify, showProperties }) => {
      // Delegate a proper modal to UI if you have one
      if (showProperties) showProperties(videos);
      else notify(`Properties: ${videos.map(v => v.name).join(', ')}`, 'info');
    },
  
    [ActionIds.MOVE_TO_TRASH]: async (videos, { electronAPI, notify, confirm = window.confirm }) => {
      for (const v of videos) {
        if (!(v.isElectronFile && v.fullPath)) continue;
        const ok = confirm(`Move "${v.name}" to trash?`);
        if (!ok) continue;
        const res = await electronAPI?.moveToTrash?.(v.fullPath);
        if (res?.success === false) notify(`Failed to trash "${v.name}"`, 'error');
        else notify(`Moved "${v.name}" to trash`, 'success');
      }
    },
  };
  