"use client";

import * as React from "react";

/**
 * The last few things chosen in the palette, per person per team. Only what the
 * palette can render on its own: a frame's action rows are never remembered,
 * because "Redeploy" with no app attached is a trap.
 */

export interface Recent {
  id: string;
  label: string;
  href: string;
  kind: "nav" | "app" | "database";
}

const CAP = 5;

const keyFor = (userId: string, teamId: string) =>
  `deplo:palette-recent:${userId}:${teamId}`;

function read(key: string): Recent[] {
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
  // Read straight into the initial state: this only ever mounts inside an open
  // dialog, so there is no server pass to mismatch and no "not read yet" guard.
  const [recents, setRecents] = React.useState<Recent[]>(() => read(key));

  const remember = React.useCallback(
    (entry: Recent) => {
      setRecents((prev) => {
        const next = [entry, ...prev.filter((r) => r.id !== entry.id)].slice(
          0,
          CAP,
        );
        try {
          window.localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* a browser with storage blocked simply keeps no history */
        }
        return next;
      });
    },
    [key],
  );

  return { recents, remember };
}
