/**
 * The result shape the UI was built around. Originally `lib/actions/result.ts`
 * (a server-action helper); lifted here, framework-neutral, so client call
 * sites keep their `if (res.ok) … else toast(res.error)` ergonomics after the
 * migration from server actions to the GraphQL API.
 */
export type ActionResult<T = undefined> =
  | { ok: true; data?: T }
  | { ok: false; error: string };
