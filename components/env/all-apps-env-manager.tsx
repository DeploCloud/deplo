"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Pencil, Trash2, Share2, ArrowUpRight } from "lucide-react";
import { SharedVarDialog } from "@/components/env/shared-vars-manager";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/empty-state";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { EnvValueCell } from "@/components/env/env-value-cell";
import { EnvVarDialog } from "@/components/env/env-var-dialog";
import { gqlAction } from "@/lib/graphql-client";
import type { EnvVarDTO } from "@/lib/types";
import type { AppEnvGroup } from "@/lib/data/env";
import type { AppliedSharedVarDTO, SharedVarDTO } from "@/lib/data/shared-vars";
import type { TeamEnvironment } from "@/lib/data/environments";

const VIA_LABEL: Record<string, string> = {
  teamWide: "Team-wide",
  environment: "Environment",
  project: "Project",
  link: "Linked",
};

/**
 * The editable aggregate of every app's variables (the Variables page's "App"
 * tab). One card per app: standalone vars with per-row edit/delete + an Add
 * button, plus the shared vars that apply, shown read-only. The same per-variable
 * editing experience as the single-app page, aggregated across the team.
 */
export function AllAppsEnvManager({
  groups,
  sharedByApp,
  sharedVars,
  projects,
  environments,
}: {
  groups: AppEnvGroup[];
  sharedByApp: Record<string, AppliedSharedVarDTO[]>;
  /** Full shared-var DTOs, so a shared row's Edit can open the shared dialog. */
  sharedVars: SharedVarDTO[];
  projects: { id: string; name: string; slug: string }[];
  environments: TeamEnvironment[];
}) {
  const [dialog, setDialog] = React.useState<{
    appId: string;
    editing: EnvVarDTO | null;
  } | null>(null);
  const [sharedEditing, setSharedEditing] = React.useState<SharedVarDTO | null>(
    null,
  );
  const [deleteId, setDeleteId] = React.useState<string | null>(null);
  const router = useRouter();
  const sharedById = React.useMemo(
    () => new Map(sharedVars.map((v) => [v.id, v] as const)),
    [sharedVars],
  );

  if (groups.length === 0) {
    return (
      <EmptyState
        icon={Plus}
        title="No apps yet"
        description="Create an app to start adding environment variables."
      />
    );
  }

  return (
    <div className="space-y-4">
      {groups.map((g) => {
        const shared = sharedByApp[g.app.id] ?? [];
        return (
          <Card key={g.app.id}>
            <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
              <CardTitle className="text-base">{g.app.name}</CardTitle>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setDialog({ appId: g.app.id, editing: null })}
                >
                  <Plus className="size-4" />
                  Add
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/apps/${g.app.slug}/environment`}>
                    Open
                    <ArrowUpRight className="size-4" />
                  </Link>
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {g.vars.length === 0 && shared.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No variables for this app.
                </p>
              ) : (
                <div className="overflow-hidden rounded-lg border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Key</TableHead>
                        <TableHead>Value</TableHead>
                        <TableHead>Environments</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {g.vars.map((v) => (
                        <TableRow key={v.id}>
                          <TableCell className="font-mono text-xs font-medium">
                            {v.key}
                          </TableCell>
                          <TableCell>
                            <EnvValueCell value={v.value} masked={v.masked} />
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1">
                              {v.targets.map((t) => (
                                <Badge key={t} variant="muted" className="text-[10px] capitalize">
                                  {t}
                                </Badge>
                              ))}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => setDialog({ appId: g.app.id, editing: v })}
                                aria-label="Edit"
                              >
                                <Pencil className="size-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="text-muted-foreground hover:text-destructive"
                                onClick={() => setDeleteId(v.id)}
                                aria-label="Delete"
                              >
                                <Trash2 className="size-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                      {shared.map((v) => (
                        <TableRow key={`${g.app.id}:${v.id}`}>
                          <TableCell className="font-mono text-xs font-medium">
                            <div className="flex items-center gap-2">
                              {v.key}
                              <Badge variant="muted" className="gap-1 text-[10px] font-normal">
                                <Share2 className="size-3" />
                                Shared · {VIA_LABEL[v.via] ?? "Shared"}
                              </Badge>
                            </div>
                          </TableCell>
                          <TableCell>
                            <span className="text-xs text-muted-foreground">
                              managed centrally
                            </span>
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1">
                              {v.targets.map((t) => (
                                <Badge key={t} variant="muted" className="text-[10px] capitalize">
                                  {t}
                                </Badge>
                              ))}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => {
                                  const full = sharedById.get(v.id);
                                  if (full) setSharedEditing(full);
                                }}
                                aria-label="Edit shared variable"
                              >
                                <Pencil className="size-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}

      {dialog && (
        <EnvVarDialog
          key={`${dialog.appId}:${dialog.editing?.id ?? "new"}`}
          open
          onOpenChange={(v) => !v && setDialog(null)}
          appId={dialog.appId}
          editing={dialog.editing}
        />
      )}
      {sharedEditing && (
        <SharedVarDialog
          key={sharedEditing.id}
          open
          onOpenChange={(v) => !v && setSharedEditing(null)}
          editing={sharedEditing}
          projects={projects}
          environments={environments}
        />
      )}
      <ConfirmAction
        open={deleteId !== null}
        onOpenChange={(v) => !v && setDeleteId(null)}
        title="Delete variable?"
        description="This removes the variable. It will no longer be available to new deployments."
        confirmLabel="Delete"
        successMessage="Variable deleted"
        onConfirm={async () => {
          const res = await gqlAction<{ deleteEnv: boolean }>(
            `mutation($id: String!) { deleteEnv(id: $id) }`,
            { id: deleteId! },
          );
          if (res.ok) router.refresh();
          return res;
        }}
      />
    </div>
  );
}
