/**
 * Where a film or an audiobook was stopped, kept in this browser only (nothing goes to the server).
 * localStorage can be unavailable or full (private window, blocked site data): the player then
 * simply starts from the beginning.
 */

const PREFIX = 'media-pos:';

export function loadPosition(path: string): number {
  try {
    const value = Number(window.localStorage.getItem(PREFIX + path));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function savePosition(path: string, seconds: number): void {
  try {
    window.localStorage.setItem(PREFIX + path, String(Math.floor(seconds)));
  } catch {
    // no storage: nothing to remember
  }
}

export function clearPosition(path: string): void {
  try {
    window.localStorage.removeItem(PREFIX + path);
  } catch {
    // no storage
  }
}

/** Resume only when it makes sense: not the first seconds and not the last ones. */
export function resumeAt(saved: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return saved > 5 && saved < duration - 8 ? saved : 0;
}
