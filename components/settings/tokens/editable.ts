import type { ApiTokenDTO } from "@/lib/data/tokens";

/**
 * Whether a screen may re-author this token, as `updateToken` itself decides it:
 * your own credential from anywhere, anyone else's from the team it is managed in.
 * One rule, because the list showing a padlock over a page that saves is the bug.
 */
export function tokenEditable(
  token: Pick<ApiTokenDTO, "createdByUserId" | "homeTeamId">,
  ctx: { userId: string; activeTeamId: string; canManage: boolean },
): boolean {
  return (
    ctx.canManage &&
    (token.createdByUserId === ctx.userId ||
      token.homeTeamId === ctx.activeTeamId)
  );
}
