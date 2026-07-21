import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs
  .readFileSync(path.resolve(process.cwd(), 'main.js'), 'utf8')
  .replaceAll('\r\n', '\n');

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('review-session main-process integration', () => {
  it('routes all persistence through the captured profile-owned metadata store', () => {
    const handlers = section(
      'ipcMain.handle("review-sessions:list"',
      'ipcMain.handle("library:set-pinned"'
    );
    expect(handlers).toContain('runMetadataContextOperation');
    expect(handlers).toContain('metadataStore.listReviewCheckpoints');
    expect(handlers).toContain('metadataStore.getReviewCheckpoint');
    expect(handlers).toContain('metadataStore.saveReviewCheckpoint');
    expect(handlers).toContain('metadataStore.clearReviewCheckpoint');
    expect(handlers.match(/assertMetadataContextActive\(context\)/g)).toHaveLength(4);
    expect(handlers).not.toContain('assertRendererPath');
    expect(handlers).not.toContain('grantRendererRoot');
  });

  it('bounds review-session root paths without changing other library handlers', () => {
    const rootNormalizer = section(
      'function normalizeReviewSessionIpcRootPath',
      'function runMetadataContextOperation'
    );
    expect(rootNormalizer).toContain('maxChars: IPC_LIMITS.maxPathChars');
    expect(rootNormalizer).toContain('trim: true');

    const handlers = section(
      'ipcMain.handle("review-sessions:list"',
      'ipcMain.handle("library:set-pinned"'
    );
    expect(
      handlers.match(/normalizeReviewSessionIpcRootPath\(payload\)/g)
    ).toHaveLength(3);
    expect(handlers).not.toContain('normalizeLibraryIpcRootPath(payload)');
  });

  it('admits only a pending owner save or acknowledgement through lifecycle gates', () => {
    const trust = section(
      'const reviewSessionFlushInboundChannels',
      'const trustedIpc = createTrustedIpcRegistrar'
    );
    expect(trust).toContain('"review-sessions:save"');
    expect(trust).toContain('REVIEW_SESSION_FLUSH_ACK_CHANNEL');
    expect(trust).toContain('reviewSessionFlushCoordinator.isPendingOwner(event.sender)');
    expect(trust).toContain('nativeShutdownRequested');
    expect(trust).toContain('reviewSessionFlushBarrierDepth > 0');

    const acknowledgement = section(
      'ipcMain.on(\n  REVIEW_SESSION_FLUSH_ACK_CHANNEL',
      'ipcMain.handle("library:set-pinned"'
    );
    expect(acknowledgement).toContain('Object.keys(payload).length !== 1');
    expect(acknowledgement).toContain(
      'reviewSessionFlushCoordinator.acknowledge(event.sender, requestId)'
    );
  });

  it('flushes before profile ownership changes, window destruction, and shutdown invalidation', () => {
    const profile = section(
      'async function reconfigureForProfile',
      'async function runSerializedProfileOperation'
    );
    expect(profile.indexOf('await runReviewSessionFlushBarrier()')).toBeLessThan(
      profile.indexOf('runSerializedProfileOperation')
    );

    const windowLifecycle = section(
      'const holdCloseForReviewSessionFlush',
      'createdWindow.once("closed"'
    );
    expect(windowLifecycle).toContain('event.preventDefault()');
    expect(windowLifecycle).toContain(
      'runReviewSessionFlushBarrier(createdWebContents)'
    );
    expect(windowLifecycle).toContain('createdWindow.close()');
    expect(windowLifecycle).not.toContain('process.platform');

    const shutdown = section(
      'async function performNativeShutdown',
      'function beginNativeShutdown'
    );
    expect(shutdown.indexOf('await runReviewSessionFlushBarrier()')).toBeLessThan(
      shutdown.indexOf('nativeShutdownRequested = true')
    );
    expect(shutdown.indexOf('await runReviewSessionFlushBarrier()')).toBeLessThan(
      shutdown.indexOf('metadataProfileGeneration += 1')
    );
    expect(shutdown.indexOf('await runReviewSessionFlushBarrier()')).toBeLessThan(
      shutdown.indexOf('invalidateNativeWorkOwner(mainWindow.webContents)')
    );
    expect(shutdown).toContain('reviewSessionFlushCoordinator.close()');
  });
});
