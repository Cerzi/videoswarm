// src/hooks/useVideoStallWatchdog.js
// Shared, ultra-light scheduler to avoid N intervals for N cards.
const subs = new Map(); // subscription token -> { check(now) }
let timer = null;

function start(intervalMs) {
  if (timer) return;
  timer = setInterval(() => {
    const now = Date.now();
    for (const s of subs.values()) {
      try { s.check(now); } catch {}
    }
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref(); // node/electron friendliness
}
function stop() {
  if (subs.size === 0 && timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Quiet stall watchdog for a <video> element:
 * - Detects "time not advancing while unpaused" across N ticks.
 * - Soft-recovers with: pause → load() → seek back → play().
 *
 * Options:
 *   id:            stable unique id (file path recommended)
 *   enabled:       only run when true (gate via isPlaying && isVisible && loaded && !adopted)
 *   tickMs:        shared scheduler period (default 2000)
 *   minDeltaSec:   minimum progress per tick to count as moving (default 0.12s)
 *   ticksToStall:  consecutive ticks with no progress before recovery (default 3)
 *   maxLogsPerMin: rate-limit per-id (default 1)
 */
export function useVideoStallWatchdog(videoRef, {
  id,
  enabled = true,
  tickMs = 2000,
  minDeltaSec = 0.12,
  ticksToStall = 3,
  maxLogsPerMin = 1,
  recoveryTimeoutMs = 4000,
  onRecover, // optional metric hook
  onRecoveryError,
  onRecoveryStart,
  onRecoveryEnd,
} = {}) {
  // Local state held in closure to avoid rerenders
  let lastT = 0;
  let noProg = 0;
  let logWindowStart = 0;
  let logsInWindow = 0;
  let disposed = false;
  let recoveryInFlight = false;
  let cancelRecovery = null;
  const subscriptionToken = Symbol(id || "video-stall-watchdog");

  const maybeLog = (level, msg, meta) => {
    const now = Date.now();
    if (!logWindowStart || now - logWindowStart > 60_000) {
      logWindowStart = now; logsInWindow = 0;
    }
    if (logsInWindow >= maxLogsPerMin) return;
    logsInWindow++;
    // eslint-disable-next-line no-console
    console[level](`[watchdog] ${msg}`, meta || {});
  };

  const subscriber = {
    check: async () => {
      if (!enabled || disposed || recoveryInFlight) return;
      const v = videoRef.current;
      if (!v) return;

      // Only care when we are actually supposed to be playing
      if (v.paused || v.readyState < 2) { lastT = v.currentTime || 0; noProg = 0; return; }

      const ct = v.currentTime || 0;
      const progressed = (ct - lastT) >= minDeltaSec;
      lastT = ct;

      if (progressed) {
        // If we previously stalled, we’ll have triggered a recovery
        if (noProg >= ticksToStall) {
          maybeLog('info', 'Recovered from stall', { id, ct, rs: v.readyState, ns: v.networkState });
        }
        noProg = 0;
        return;
      }

      // No progress this tick
      noProg++;
      if (noProg < ticksToStall) return;

      // Confirmed stall → attempt soft recovery once
      noProg = 0;
      const t = v.currentTime || 0;
      maybeLog('warn', 'Stall detected — attempting soft recovery', {
        id, t, rs: v.readyState, ns: v.networkState, src: v.currentSrc || v.src,
      });

      recoveryInFlight = true;
      onRecoveryStart?.();
      let recoveryTimeoutId = null;
      try {
        v.pause();
        v.load();                // reset decode graph
        try { v.currentTime = t; } catch {}
        const playResult = v.play();
        if (playResult?.then) {
          await Promise.race([
            playResult,
            new Promise((_, reject) => {
              recoveryTimeoutId = setTimeout(
                () => reject(new Error('Timed out recovering stalled playback')),
                recoveryTimeoutMs
              );
            }),
            new Promise((_, reject) => {
              cancelRecovery = () =>
                reject(new Error('Stall recovery cancelled'));
            }),
          ]);
        }
        const readyThreshold =
          (typeof HTMLMediaElement !== 'undefined' &&
            Number(HTMLMediaElement.HAVE_CURRENT_DATA)) ||
          2;
        if (v.readyState < readyThreshold) {
          throw new Error('Stall recovery did not produce playable data');
        }
        if (disposed || videoRef.current !== v) return;
        if (onRecover) onRecover({ id, t });
      } catch (e) {
        if (disposed || videoRef.current !== v) return;
        maybeLog('warn', 'Recovery failed', { id, err: String(e) });
        onRecoveryError?.(e);
      } finally {
        if (recoveryTimeoutId) clearTimeout(recoveryTimeoutId);
        cancelRecovery = null;
        recoveryInFlight = false;
        onRecoveryEnd?.();
      }
    }
  };

  // Register immediately on first call, unregister on teardown/disable.
  if (enabled && id) {
    subs.set(subscriptionToken, subscriber);
    start(tickMs);
  }

  return () => {
    disposed = true;
    cancelRecovery?.();
    subs.delete(subscriptionToken);
    stop();
  };
}
