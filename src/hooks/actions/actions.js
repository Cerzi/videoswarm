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

    [ActionIds.MOVE_TO_TRASH]: async (
        videos,
        {
          electronAPI,
          notify,
          confirm = window.confirm,
          releaseVideoHandlesForAsync,      // inject this
          onItemsRemoved,                   // inject: (movedSet: Set<string>) => void
        }
      ) => {
        const candidates = videos
          .filter(v => v.isElectronFile && v.fullPath)
          .map(v => v.fullPath);
      
        if (candidates.length === 0) {
          notify('Nothing to trash', 'info');
          return;
        }
      
        if (!confirm(`Move ${candidates.length} item(s) to Recycle Bin?`)) return;
      
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const isTransient = (msg = '') =>
          /aborted|busy|access is denied|used by another process|locked|eperm|eacces|ebusy/i.test(msg);
      
        // 1) Pre-release (awaited)
        try { await releaseVideoHandlesForAsync?.(candidates); } catch {}
      
        // 2) First bulk attempt
        let result = await electronAPI?.bulkMoveToTrash?.(candidates);
        const failed = Array.isArray(result?.failed) ? result.failed.slice() : [];
      
        // 3) Targeted retries on transient errors (per-file; bounded)
        const retryList = failed
          .filter(f => isTransient(String(f.error || '').toLowerCase()))
          .map(f => f.path)
          .filter(Boolean);
      
        const finalFailed = failed.filter(f => !retryList.includes(f.path));
        for (const p of retryList) {
          let ok = false;
          for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
            await sleep(100 * attempt);
            try { await releaseVideoHandlesForAsync?.([p]); } catch {}
            const res = await electronAPI?.bulkMoveToTrash?.([p]);
            if (res?.moved?.includes?.(p)) ok = true;
            else {
              const err = res?.failed?.find?.(f => f.path === p)?.error;
              if (!isTransient(String(err || '')) || attempt === 2) {
                finalFailed.push({ path: p, error: err || 'Unknown error' });
              }
            }
          }
          if (ok) {
            result.moved = [...(result.moved || []), p];
          }
        }
      
        const moved = new Set(result?.moved || []);
      
        // 4) Optimistically update the model NOW (so cards unmount immediately)
        if (moved.size) onItemsRemoved?.(moved);
      
        // 5) Final release pass for the confirmed moved files
        if (moved.size) {
          try { await releaseVideoHandlesForAsync?.(Array.from(moved)); } catch {}
        }
      
        // 6) Notify
        const movedCount = moved.size;
        const failedCount = finalFailed.length;
        if (movedCount && !failedCount) {
          notify(`Moved ${movedCount} item(s) to Recycle Bin`, 'success');
        } else if (movedCount && failedCount) {
          notify(`Moved ${movedCount}, ${failedCount} failed (in use)`, 'warning');
          console.warn('[trash] failed entries:', finalFailed);
        } else {
          notify('Failed to move items to Recycle Bin', 'error');
          console.warn('[trash] bulk failure:', result);
        }
      },
            
};
