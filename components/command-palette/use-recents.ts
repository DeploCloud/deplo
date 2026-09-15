"use client";

import * as React from "react";

export interface Recent {
  id: string;
  label: string;
  href: string;
}

const CAP = 5;

const keyFor = (userId: string, teamId: string) =>
  `deplo:palette-recent:${userId}:${teamId}`;

export function readRecents(key: string): Recent[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (r): r is Recent =>
          typeof r === "object" &&
          r !== null &&
          typeof (r as Recent).id === "string" &&
          typeof (r as Recent).label === "string" &&
          typeof (r as Recent).href === "string",
      )
      .slice(0, CAP);
  } catch {
    return [];
  }
}

export function useRecents(userId: string, teamId: string) {
  const key = keyFor(userId, teamId);
  const [recents, setRecents] = React.useState<Recent[]>(() =>
    readRecents(key),
  );
  const current = React.useRef(recents);

  const remember = React.useCallback(
    (entry: Recent) => {
      const next = nextRecents(current.current, entry);
      current.current = next;
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {}
      setRecents(next);
    },
    [key],
  );

  return { recents, remember };
}

export function nextRecents(prev: Recent[], entry: Recent): Recent[] {
  return [entry, ...prev.filter((r) => r.id !== entry.id)].slice(0, CAP);
}
