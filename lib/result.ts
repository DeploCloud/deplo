/**
 * The result shape the UI was built around.
 */
export type ActionResult<T = undefined> =
  { ok: true; data?: T } | { ok: false; error: string };
