const STALE_PATTERNS = [
  /ChunkLoadError/i,
  /Failed to load chunk/i,
  /Loading chunk \S+ failed/i,
  /Loading CSS chunk \S+ failed/i,
  /(Failed to fetch|error loading) dynamically imported module/i,
  /Importing a module script failed/i,
];

// A page whose stream the network cut halfway: the installed app went to the background mid-load.
const INTERRUPTED_PATTERNS = [
  /Connection closed/i,
  /react\.dev\/errors\/412\b/,
  /^(TypeError: )?(network error|Load failed|Failed to fetch)$/i,
  /Error in input stream/i,
  /NetworkError when attempting to fetch/i,
  /network connection was lost/i,
  /Internet connection appears to be offline/i,
];

function errorText(error: unknown): string {
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : String(error);
}

export function isStaleBuildError(error: unknown): boolean {
  if (!error) return false;
  const name = (error as { name?: unknown }).name;
  if (name === "ChunkLoadError") return true;
  const text = errorText(error);
  return STALE_PATTERNS.some((re) => re.test(text));
}

export function isInterruptedLoadError(error: unknown): boolean {
  if (!error || isStaleBuildError(error)) return false;
  const text = errorText(error);
  return INTERRUPTED_PATTERNS.some((re) => re.test(text));
}

/** Why a crashed page can heal itself with a reload, or null when it is a real crash. */
export function recoverableError(
  error: unknown,
): "stale" | "interrupted" | null {
  if (isStaleBuildError(error)) return "stale";
  if (isInterruptedLoadError(error)) return "interrupted";
  return null;
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

// A reload while the app is still in the background or offline fails the same way: wait for both.
export function reloadWhenBack(): () => void {
  const stop = () => {
    document.removeEventListener("visibilitychange", go);
    window.removeEventListener("online", go);
  };
  function go() {
    if (document.hidden || !navigator.onLine) return;
    stop();
    reloadOnce();
  }
  document.addEventListener("visibilitychange", go);
  window.addEventListener("online", go);
  go();
  return stop;
}
