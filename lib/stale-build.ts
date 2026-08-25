/**
 * Recovering from a tab that outlived the build it was loaded from.
 */

/** Bundler/browser wordings for "the JS file I asked for isn't there". */
const STALE_PATTERNS = [
  /ChunkLoadError/i,
  /Failed to load chunk/i, // Turbopack
  /Loading chunk \S+ failed/i, // webpack
  /Loading CSS chunk \S+ failed/i,
  /(Failed to fetch|error loading) dynamically imported module/i, // Chrome / Firefox
  /Importing a module script failed/i, // Safari
];

/** True when `error` means "this tab is running against a build that is gone". */
export function isStaleBuildError(error: unknown): boolean {
  if (!error) return false;
  const name = (error as { name?: unknown }).name;
  if (name === "ChunkLoadError") return true;
  const message = (error as { message?: unknown }).message;
  const text = typeof message === "string" ? message : String(error);
  return STALE_PATTERNS.some((re) => re.test(text));
}

/** Only one automatic reload per tab per window of time — see {@link reloadOnce}. */
const RELOAD_KEY = "deplo:stale-build-reload";
const RELOAD_COOLDOWN_MS = 30_000;

/**
 * Reload the page once to pick up the current build. Returns false when a reload
 * was already attempted moments ago — a chunk that 404s on the fresh build too
 * (a half-finished deploy) must land on a message, never in a reload loop.
 */
export function reloadOnce(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < RELOAD_COOLDOWN_MS) return false;
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // Storage blocked (private mode, embedded browsers): reloading once is still
    // the right move — the cooldown is a nicety, not the guard that matters.
  }
  window.location.reload();
  return true;
}
