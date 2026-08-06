import { Lock } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";

/**
 * A whole page a member on a LIMITED role cannot have, rendered as a page rather
 * than thrown.
 *
 * Every section this stands in for is team-wide by nature — the roster, the
 * roles, the Git connections, the notification channels, the team's tokens —
 * and losing them is what a role scope MEANS (ADR-0016). Crashing on them is
 * not: the loaders behind them open with `requireTeamWide`, which throws, and
 * with no `error.tsx` under `/settings` the dashboard boundary answered
 * "Something went wrong" and dropped the honest message. `reachesWholeTeam()`
 * is the non-throwing twin these pages should have been asking all along.
 *
 * Kept as one component because five pages need the identical two blocks and a
 * sixth (`/settings`) and seventh (`/storage`, `/monitoring`) already hand-roll
 * them: a section that says "not yours" should look the same everywhere.
 */
export function OutsideYourAccess({
  title,
  description,
  what,
}: {
  /** The page's own title, so the header is unchanged from the normal render. */
  title: string;
  /** The page's own subtitle. */
  description: string;
  /** What the member is missing, as a sentence subject: "The member roster". */
  what: string;
}) {
  return (
    <div className="space-y-6">
      <PageHeader title={title} description={description} />
      <EmptyState
        icon={Lock}
        title="Outside your access"
        description={`Your role reaches part of this team. ${what} belongs to the whole of it.`}
      />
    </div>
  );
}
