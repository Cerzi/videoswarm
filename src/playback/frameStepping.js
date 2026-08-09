// Frame arithmetic for the fullscreen loupe's frame picker.
//
// Seeking to a frame boundary is ambiguous: `index / fps` sits exactly on the
// edge between two frames, so floating-point error decides which one the
// decoder presents. Every seek here therefore targets the middle of the
// intended frame, which is unambiguous for any plausible frame rate.

// Below 1fps a "frame" stops being a useful step unit, and above 1000fps the
// mid-frame offset stops being representable against typical clip durations.
const MIN_FRAME_RATE = 1;
const MAX_FRAME_RATE = 1000;
// Generated clips are overwhelmingly produced at this rate, and it is a far
// better guess than refusing to step at all when a clip was never probed.
export const FALLBACK_FRAME_RATE = 24;

export const resolveFrameRate = (value) => {
  const frameRate = Number(value);
  if (!Number.isFinite(frameRate) || frameRate <= 0) return FALLBACK_FRAME_RATE;
  if (frameRate < MIN_FRAME_RATE) return MIN_FRAME_RATE;
  if (frameRate > MAX_FRAME_RATE) return MAX_FRAME_RATE;
  return frameRate;
};

const safeDuration = (value) => {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
};

const safeTime = (value) => {
  const time = Number(value);
  return Number.isFinite(time) && time > 0 ? time : 0;
};

/** Zero-based index of the frame displayed at `time`. */
export const frameIndexAt = (time, frameRate) => {
  const fps = resolveFrameRate(frameRate);
  // A tiny epsilon absorbs the rounding that leaves a seeked position a
  // fraction below its own boundary, which would otherwise report the
  // preceding frame immediately after stepping onto this one.
  return Math.max(0, Math.floor(safeTime(time) * fps + 1e-6));
};

/**
 * Total frames in a clip. Returns 0 when the duration is unknown, which the
 * caller shows as an open-ended position rather than a wrong total.
 */
export const frameCountFor = (duration, frameRate) => {
  const seconds = safeDuration(duration);
  if (!seconds) return 0;
  return Math.max(1, Math.round(seconds * resolveFrameRate(frameRate)));
};

export const lastFrameIndexFor = (duration, frameRate) => {
  const count = frameCountFor(duration, frameRate);
  return count > 0 ? count - 1 : 0;
};

/** Mid-frame timestamp to seek to in order to display `index`. */
export const frameStartTime = (index, frameRate, duration = 0) => {
  const fps = resolveFrameRate(frameRate);
  const target = (Math.max(0, Math.floor(index)) + 0.5) / fps;
  const seconds = safeDuration(duration);
  if (!seconds) return target;
  // Never seek to or past the duration; some decoders settle on the very last
  // frame there and a further step would appear to do nothing.
  return Math.min(target, Math.max(0, seconds - 0.5 / fps));
};

/**
 * Resolve one step. Returns null when the step would leave the clip, so the
 * caller can leave the position untouched instead of re-seeking to where it
 * already is. Stepping is deliberately clamped rather than wrapping: the
 * fullscreen element loops during playback, and a frame picker that jumped
 * from the last frame back to the first would lose the user's place.
 */
export const resolveFrameStep = ({
  currentTime,
  duration,
  frameRate,
  direction,
} = {}) => {
  const step = Number(direction) < 0 ? -1 : 1;
  const fps = resolveFrameRate(frameRate);
  const currentIndex = frameIndexAt(currentTime, fps);
  const maxIndex = lastFrameIndexFor(duration, fps);
  const requested = currentIndex + step;
  const seconds = safeDuration(duration);
  const targetIndex = seconds
    ? Math.min(Math.max(requested, 0), maxIndex)
    : Math.max(requested, 0);
  if (targetIndex === currentIndex) return null;
  return {
    index: targetIndex,
    time: frameStartTime(targetIndex, fps, duration),
  };
};

/** Display string for the frame readout, e.g. "12 / 121" or "12". */
export const formatFramePosition = (index, total) => {
  const position = Math.max(0, Math.floor(Number(index) || 0)) + 1;
  const count = Math.max(0, Math.floor(Number(total) || 0));
  if (!count) return String(position);
  return `${position} / ${count}`;
};
