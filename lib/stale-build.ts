const STALE_PATTERNS = [
  /ChunkLoadError/i,
  /Failed to load chunk/i, // Turbopack
  /Loading chunk \S+ failed/i, // webpack
  /Loading CSS chunk \S+ failed/i,
  /(Failed to fetch|error loading) dynamically imported module/i, // Chrome / Firefox
  /Importing a module script failed/i, // Safari
];

// isStaleBuildError: true when `error` means this tab runs against a build that is gone.
export function isStaleBuildError(error: unknown): boolean {
  if (!error) return false;
  const name = (error as { name?: unknown }).name;
  if (name === "ChunkLoadError") return true;
  const message = (error as { message?: unknown }).message;
  const text = typeof message === "string" ? message : String(error);
  return STALE_PATTERNS.some((re) => re.test(text));
}

const RELOAD_KEY = "deplo:stale-build-reload";
const RELOAD_COOLDOWN_MS = 30_000;

// reloadOnce reloads once for the current build; false when one was just tried, so a bad chunk cannot loop.
export function reloadOnce(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < RELOAD_COOLDOWN_MS) return false;
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // Storage blocked (private mode): reload anyway, the cooldown is a nicety.
  }
  window.location.reload();
  return true;
}
