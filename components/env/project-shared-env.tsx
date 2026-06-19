"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Share2, ArrowUpRight } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { setSharedEnvGroupAttachmentAction } from "@/lib/actions/shared-env";
import type { ProjectSharedEnvGroupDTO } from "@/lib/data/shared-env";

export function ProjectSharedEnv({
  projectId,
  groups,
}: {
  projectId: string;
  groups: ProjectSharedEnvGroupDTO[];
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Shared groups</h3>
          <p className="text-sm text-muted-foreground">
            Attach a reusable group to inject its variables alongside this
            project&apos;s own. They reach the runtimes the group targets.
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link href="/variables?tab=shared">
            Manage groups
            <ArrowUpRight className="size-4" />
          </Link>
        </Button>
      </div>

      {groups.length === 0 ? (
        <EmptyState
          icon={Share2}
          title="No shared groups yet"
          description="Create a shared group from the Variables page to reuse the same variables across projects."
        />
      ) : (
        <div className="grid gap-3">
          {groups.map((g) => (
            <SharedGroupRow key={g.id} projectId={projectId} group={g} />
          ))}
        </div>
      )}
    </div>
  );
}

function SharedGroupRow({
  projectId,
  group,
}: {
  projectId: string;
  group: ProjectSharedEnvGroupDTO;
}) {
  // Optimistic so the switch tracks instantly; the action revalidates the page,
  // which reconciles this to the durable value on the next render.
  const [attached, setAttached] = React.useState(group.attached);
  const [pending, startTransition] = React.useTransition();

  function toggle(next: boolean) {
    setAttached(next);
    startTransition(async () => {
      const res = await setSharedEnvGroupAttachmentAction({
        groupId: group.id,
        projectId,
        attached: next,
      });
      if (res.ok) {
        toast.success(next ? "Group attached" : "Group detached");
      } else {
        setAttached(!next);
        toast.error(res.error);
      }
    });
  }

  return (
    <Card>
      <CardContent className="flex items-start justify-between gap-4 p-4">
        <div className="min-w-0 space-y-2">
          <p className="flex items-center gap-2 font-medium">
            <Share2 className="size-4 text-muted-foreground" />
            {group.name}
          </p>
          {group.description && (
            <p className="text-xs text-muted-foreground">{group.description}</p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {group.keys.map((k) => (
              <Badge key={k} variant="muted" className="font-mono text-[10px]">
                {k}
              </Badge>
            ))}
            {group.keys.length === 0 && (
              <span className="text-xs text-muted-foreground">No variables</span>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Targets:</span>
            <div className="flex flex-wrap gap-1">
              {group.targets.map((t) => (
                <Badge key={t} variant="muted" className="text-[10px] capitalize">
                  {t}
                </Badge>
              ))}
            </div>
          </div>
        </div>
        <Switch
          checked={attached}
          onCheckedChange={toggle}
          disabled={pending}
          aria-label={attached ? "Detach group" : "Attach group"}
        />
      </CardContent>
    </Card>
  );
}
