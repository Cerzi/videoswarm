module.exports = function registerTrashIPC(ipcMain) {
    const { shell } = require('electron');
    const fsRaw = require('fs');
    ipcMain.handle('bulk-move-to-trash', async (_event, paths) => {
        // ===== Bulk move-to-trash =====
        const { shell } = require('electron');
        const fsRaw = require('fs'); // sync exists check is OK here
        const results = { moved: [], failed: [] };

        try {
            if (!Array.isArray(paths)) {
                console.error('[bulk-move-to-trash] invalid payload:', paths);
                return { success: false, moved: [], failed: [{ path: null, error: 'Invalid payload (expected array)' }] };
            }

            console.log(`[bulk-move-to-trash] requested: ${paths.length} item(s)`);
            for (const p of paths) {
                if (typeof p !== 'string' || !p.trim()) {
                    console.warn('[bulk-move-to-trash] skip invalid path:', p);
                    results.failed.push({ path: p, error: 'Invalid path' });
                    continue;
                }
                if (!fsRaw.existsSync(p)) {
                    console.warn('[bulk-move-to-trash] not found:', p);
                    results.failed.push({ path: p, error: 'File not found' });
                    continue;
                }

                try {
                    // Electron’s shell.trashItem returns a Promise that resolves on success
                    await shell.trashItem(p);
                    results.moved.push(p);
                    console.log('[bulk-move-to-trash] moved to trash:', p);
                } catch (e) {
                    const msg = (e && e.message) || String(e);
                    console.error('[bulk-move-to-trash] failed:', p, msg);
                    results.failed.push({ path: p, error: msg });
                }
            }

            console.log(`[bulk-move-to-trash] done: moved=${results.moved.length} failed=${results.failed.length}`);
            return { success: true, ...results };
        } catch (e) {
            const msg = (e && e.message) || String(e);
            console.error('[bulk-move-to-trash] fatal:', msg);
            return { success: false, moved: results.moved, failed: [...results.failed, { path: null, error: msg }] };
        }
    });
}