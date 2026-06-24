import "server-only";

import { mutate, read } from "../store";

/**
 * Bridge for the team-wide ordering fields during the (b)→(c) migration window
 * (relational-store PLAN cut-sets b and c).
 *
 * Cut-set (b) moved the `teams` ROW to Postgres, but `projectOrder`/`folderOrder`
 * are NOT columns on the relational `teams` table — they migrate to the
 * `team_project_order`/`team_folder_order` junctions in cut-set (c). So during
 * the window between the two cut-sets those two array fields still live ONLY on
 * the JSONB `teams` object, and `listProjects`/`reorderProjects`/`createFolder`
 * (cut-set c modules, still JSONB) read/write them via `read().teams.find(...)`.
 *
 * A team created through the now-relational `createTeam`/`createAccountWithTeam`
 * no longer writes a JSONB `teams` row, so those order reads/writes would silently
 * no-op for it (a brand-new team would lose its saved Overview/folder order). This
 * writes a MINIMAL JSONB stub — id + empty order arrays only — so the ordering
 * code has a home to attach to until cut-set (c) retires it. It is deliberately
 * NOT the authoritative team record (Postgres is); it carries only the two
 * not-yet-migrated ordering fields.
 */
export function ensureTeamOrderStub(teamId: string): void {
  if (read().teams.some((t) => t.id === teamId)) return;
  mutate((d) => {
    if (d.teams.some((t) => t.id === teamId)) return;
    d.teams.push({
      id: teamId,
      // Placeholder identity fields — the relational row is authoritative; only
      // projectOrder/folderOrder are ever read off this stub.
      name: "",
      slug: "",
      plan: "pro",
      createdAt: "",
      projectOrder: [],
      folderOrder: [],
    });
  });
}
