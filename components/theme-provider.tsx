"use client";

import * as React from "react";

export type Theme = "light" | "dark" | "system";
type Resolved = "light" | "dark";

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  resolvedTheme: Resolved;
}

const ThemeContext = React.createContext<ThemeContextValue | undefined>(
  undefined,
);

const STORAGE_KEY = "theme";
const MQ = "(prefers-color-scheme: dark)";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

function systemResolved(): Resolved {
  return window.matchMedia(MQ).matches ? "dark" : "light";
}

/** Apply the resolved theme to <html> (class + color-scheme). Client only. */
function applyClass(resolved: Resolved) {
  const el = document.documentElement;
  el.classList.remove("light", "dark");
  el.classList.add(resolved);
  el.style.colorScheme = resolved;
}

/**
 * Persist the RESOLVED theme in a cookie so the SERVER can set the <html> class
 * on the next load — the zero-flash mechanism that replaces an inline bootstrap
 * script (React 19.2 refuses to execute inline scripts rendered through React,
 * server or client, and warns). The cookie holds the concrete light/dark to
 * paint; the raw preference (incl. "system") lives in localStorage for the UI.
 */
function writeCookie(resolved: Resolved) {
  try {
    document.cookie = `${STORAGE_KEY}=${resolved}; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax`;
  } catch {
    /* cookies unavailable */
  }
}

/**
 * Minimal theme provider — replaces `next-themes`, which rendered its no-flash
 * <script> from a client component (React 19.2 warns that such inline scripts
 * never run on the client). Here the server paints the initial theme from the
 * cookie and this provider owns the live state: current preference, the
 * system-resolved value, toggling, and keeping the cookie + <html> class in sync.
 */
export function ThemeProvider({
  children,
  defaultTheme = "dark",
}: {
  children: React.ReactNode;
  /** SSR-resolved theme (from the cookie) — the deterministic initial value. */
  defaultTheme?: Theme;
}) {
  const [theme, setThemeState] = React.useState<Theme>(defaultTheme);
  const [resolvedTheme, setResolvedTheme] = React.useState<Resolved>(
    defaultTheme === "light" ? "light" : "dark",
  );

  // Reconcile to the persisted preference after mount. The server already
  // painted the cookie's value, so for the common case this is a no-op; it only
  // changes the DOM when the preference is "system" or the cookie was stale.
  React.useEffect(() => {
    let pref: string | null = null;
    try {
      pref = localStorage.getItem(STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
    const next: Theme =
      pref === "light" || pref === "dark" || pref === "system"
        ? pref
        : defaultTheme;
    const resolved = next === "system" ? systemResolved() : next;
    /* eslint-disable react-hooks/set-state-in-effect -- reconcile to stored preference post-mount */
    setThemeState(next);
    setResolvedTheme(resolved);
    /* eslint-enable react-hooks/set-state-in-effect */
    applyClass(resolved);
    writeCookie(resolved);
  }, [defaultTheme]);

  // While following the system, track OS changes and re-apply.
  React.useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia(MQ);
    const onChange = () => {
      const r: Resolved = mq.matches ? "dark" : "light";
      setResolvedTheme(r);
      applyClass(r);
      writeCookie(r);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = React.useCallback((next: Theme) => {
    const resolved = next === "system" ? systemResolved() : next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* storage unavailable */
    }
    writeCookie(resolved);
    setThemeState(next);
    setResolvedTheme(resolved);
    applyClass(resolved);
  }, []);

  const value = React.useMemo<ThemeContextValue>(
    () => ({ theme, setTheme, resolvedTheme }),
    [theme, setTheme, resolvedTheme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

/** Read the current theme + setter. Permissive fallback so it never crashes. */
export function useTheme(): ThemeContextValue {
  return (
    React.useContext(ThemeContext) ?? {
      theme: "dark",
      setTheme: () => {},
      resolvedTheme: "dark",
    }
  );
}
