// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Path-containment safety for build trees. A user-supplied `rootDirectory` (or an
 * archive's own layout) must never let a build escape the temp tree Deplo
 * extracted/cloned into.
 */

import { realpath, stat } from "node:fs/promises";
import { sep } from "node:path";

/**
 * Canonicalise `candidate` (a path that joins a user-supplied rootDirectory onto
 * an extracted/cloned root) and confirm it is `base` itself or a real descendant
 * of it - defeating symlink escapes that a string-prefix check would miss.
 */
export async function safeBuildDir(
  base: string,
  candidate: string,
): Promise<string> {
  // `base` is always a temp dir we created, so realpath(base) won't throw.
  const realBase = await realpath(base).catch(() => base);
  try {
    const realCandidate = await realpath(candidate);
    const contained =
      realCandidate === realBase || realCandidate.startsWith(realBase + sep);
    if (!contained) return realBase;
    const st = await stat(realCandidate);
    return st.isDirectory() ? realCandidate : realBase;
  } catch {
    return realBase;
  }
}
