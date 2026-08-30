// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The monogram palette, shared by the browser and the server.
 */
export const AVATAR_COLORS = [
  "#50e3c2",
  "#f5a623",
  "#7928ca",
  "#ff0080",
  "#0070f3",
] as const;

/**
 * A stable colour for something that has no stored one - a team. Derived from the
 * NAME rather than the id because the letters on the mark are too: rename the team
 * and the whole mark changes together, instead of new letters on the old colour.
 */
export function monogramColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}
