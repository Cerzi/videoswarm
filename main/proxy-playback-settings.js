// Playback proxies are on by default from revision 1 (2026-10-17). Settings
// written before then hold `false` because it was the default, not because
// anyone chose it, so revision 1 turns proxies on once; a later choice is
// saved with the revision and sticks. Proxies only feed the grid: fullscreen
// always plays the original.
const PROXY_PLAYBACK_REVISION = 1;

const resolveProxyPlaybackEnabled = (source) => {
  if (!(Number(source?.proxyPlaybackRevision) >= PROXY_PLAYBACK_REVISION)) return true;
  return source.proxyPlaybackEnabled === undefined
    ? true
    : source.proxyPlaybackEnabled === true;
};

module.exports = {
  PROXY_PLAYBACK_REVISION,
  resolveProxyPlaybackEnabled,
};
