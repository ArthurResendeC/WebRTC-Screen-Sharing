const VOLUME_KEY = 'screen-share:viewer-volume';
const DEFAULT_VOLUME = 1;

function clampVolume(volume: number) {
  if (!Number.isFinite(volume)) return DEFAULT_VOLUME;
  return Math.max(0, Math.min(1, volume));
}

export function recallViewerVolume() {
  try {
    const stored = localStorage.getItem(VOLUME_KEY);
    return stored ? clampVolume(Number(stored)) : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME;
  }
}

export function rememberViewerVolume(volume: number) {
  try {
    localStorage.setItem(VOLUME_KEY, String(clampVolume(volume)));
  } catch {
    // The chosen volume still applies to the current streams.
  }
}
