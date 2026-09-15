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
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function systemResolved(): Resolved {
  return window.matchMedia(MQ).matches ? "dark" : "light";
}

function applyClass(resolved: Resolved) {
  const el = document.documentElement;
  el.classList.remove("light", "dark");
  el.classList.add(resolved);
  el.style.colorScheme = resolved;
}

function writeCookie(resolved: Resolved) {
  try {
    document.cookie = `${STORAGE_KEY}=${resolved}; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax`;
  } catch {}
}

export function ThemeProvider({
  children,
  defaultTheme = "dark",
}: {
  children: React.ReactNode;
  defaultTheme?: Theme;
}) {
  const [theme, setThemeState] = React.useState<Theme>(defaultTheme);
  const [resolvedTheme, setResolvedTheme] = React.useState<Resolved>(
    defaultTheme === "light" ? "light" : "dark",
  );

  React.useEffect(() => {
    let pref: string | null = null;
    try {
      pref = localStorage.getItem(STORAGE_KEY);
    } catch {}
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
    } catch {}
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

export function useTheme(): ThemeContextValue {
  return (
    React.useContext(ThemeContext) ?? {
      theme: "dark",
      setTheme: () => {},
      resolvedTheme: "dark",
    }
  );
}
