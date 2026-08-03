import {
  Activity as ActivityIcon,
  Archive,
  Box,
  Boxes,
  Brush,
  Database,
  Gauge,
  Globe,
  HardDrive,
  KeyRound,
  Rocket,
  Users,
  type LucideIcon,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { timeAgo } from "@/lib/utils";
import type { Activity, ActivityType } from "@/lib/types";

const ICON_BY_TYPE: Record<ActivityType, LucideIcon> = {
  deployment: Rocket,
  app: Box,
  project: Boxes,
  database: Database,
  domain: Globe,
  env: KeyRound,
  member: Users,
  backup: Archive,
  s3: HardDrive,
  cleanup: Brush,
  monitoring: Gauge,
};

/**
 * What this person has done, newest first, across every team on the instance.
 *
 * Capped rather than paginated: the full, filterable feed already exists at
 * /activity, and this card answers a different question — "is this account
 * active, and what does it touch?" — which ten rows answer as well as a hundred.
 * The sub-line names the TEAM rather than the actor, because the actor is the
 * page.
 */
export function UserActivityCard({
  activity,
}: {
  activity: (Activity & { teamName: string })[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-base">
          Activity
          <InfoTip content="What this person has done across every team." />
        </CardTitle>
      </CardHeader>
      <CardContent>
        {activity.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing yet. This account hasn&apos;t done anything.
          </p>
        ) : (
          <ol className="relative space-y-4">
            <span
              aria-hidden
              className="absolute left-[15px] top-2 bottom-2 w-px bg-border"
            />
            {activity.map((a) => {
              const Icon = ICON_BY_TYPE[a.type] ?? ActivityIcon;
              return (
                <li key={a.id} className="relative flex items-start gap-3">
                  <div className="relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-secondary">
                    <Icon className="size-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1 pt-1">
                    <p className="text-sm text-foreground">{a.message}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {a.teamName} · {timeAgo(a.createdAt)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
