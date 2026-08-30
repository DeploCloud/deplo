"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

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
  // Read straight into the initial state: this only ever mounts inside an open
  // dialog, so there is no server pass to mismatch and no "not read yet" guard.
  const [recents, setRecents] = React.useState<Recent[]>(() =>
    readRecents(key),
  );
  // A mirror, so the write below happens next to the call and not inside a
  // state updater - React may run one of those more than once, and a
  // reducer that touches storage is not a reducer.
  const current = React.useRef(recents);

  const remember = React.useCallback(
    (entry: Recent) => {
      const next = nextRecents(current.current, entry);
      current.current = next;
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* a browser with storage blocked simply keeps no history */
      }
      setRecents(next);
    },
    [key],
  );

  return { recents, remember };
}

/** Most recent first, one row per id, capped. Pure, so it can be tested. */
export function nextRecents(prev: Recent[], entry: Recent): Recent[] {
  return [entry, ...prev.filter((r) => r.id !== entry.id)].slice(0, CAP);
}
