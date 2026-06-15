export type ActionResult<T = undefined> =
  | { ok: true; data?: T }
  | { ok: false; error: string };

/** Wrap a DAL call so thrown errors become a typed failure result. */
export async function run<T>(
  fn: () => Promise<T>
): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Something went wrong";
    // Never leak internal stack traces to the client.
    return { ok: false, error: message };
  }
}
