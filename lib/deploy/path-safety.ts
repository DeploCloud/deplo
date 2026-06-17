/**
 * Path-containment safety for build trees.
 *
 * A user-supplied `rootDirectory` (or an archive's own layout) must never let a
 * build escape the temp tree Deplo extracted/cloned into. This is its own
 * concern, distinct from archive streaming (upload.ts) and from the source
 * decision (source.ts) — both of which use it — so it lives in its own module.
 *
 * No `server-only`: it touches only `node:fs/promises` + `node:path`, so it
 * imports cleanly under a plain test runner. Its interface IS its test surface.
 */

import { realpath, stat } from "node:fs/promises";
import { sep } from "node:path";

/**
 * Canonicalise `candidate` (a path that joins a user-supplied rootDirectory
 * onto an extracted/cloned root) and confirm it is `base` itself or a real
 * descendant of it — defeating symlink escapes that a string-prefix check would
 * miss. Returns the canonical contained directory, else the canonical `base`.
 * Always returns `realpath(base)` on any fallback, so callers can detect a
 * fallback by comparing the result to `realpath(base)` (a typo'd rootDirectory).
 * Uses a path-separator boundary so a sibling like `<base>-evil` can't match.
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
