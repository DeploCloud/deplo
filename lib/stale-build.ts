const STALE_PATTERNS = [
  /ChunkLoadError/i,
  /Failed to load chunk/i,
  /Loading chunk \S+ failed/i,
  /Loading CSS chunk \S+ failed/i,
  /(Failed to fetch|error loading) dynamically imported module/i,
  /Importing a module script failed/i,
];

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

export function reloadOnce(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < RELOAD_COOLDOWN_MS) return false;
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {}
  window.location.reload();
  return true;
}
