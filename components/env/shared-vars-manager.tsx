"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, Share2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/empty-state";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { FieldLabel } from "@/components/ui/info-tip";
import { EnvValueCell } from "@/components/env/env-value-cell";
import { gqlAction } from "@/lib/graphql-client";
import type { EnvTarget } from "@/lib/types";
import type { SharedVarDTO } from "@/lib/data/shared-vars";
import type { TeamEnvironment } from "@/lib/data/environments";

const ALL_TARGETS: EnvTarget[] = ["production", "preview", "development"];

type ProjectRef = { id: string; name: string; slug: string };

/**
 * The unified "Shared" tab: every shared variable of the team with create / edit
 * / delete and the three sharing modes (team-wide / environments / projects).
 */
export function SharedVarsManager({
  vars,
  projects,
  environments,
}: {
  vars: SharedVarDTO[];
  projects: ProjectRef[];
  environments: TeamEnvironment[];
}) {
  const [dialog, setDialog] = React.useState<{ editing: SharedVarDTO | null } | null>(
    null,
  );
  const [deleteId, setDeleteId] = React.useState<string | null>(null);
  const router = useRouter();

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-medium">Shared variables</h3>
          <p className="text-sm text-muted-foreground">
            Define a variable once and share it by environment, project, or with the
            whole team.
          </p>
        </div>
        <Button size="sm" onClick={() => setDialog({ editing: null })}>
          <Plus className="size-4" />
          New shared variable
        </Button>
      </div>

      {vars.length === 0 ? (
        <EmptyState
          icon={Share2}
          title="No shared variables yet"
          description="Create a shared variable to reuse it across environments, projects, or the whole team."
        />
      ) : (
        <div className="rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Shared with</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vars.map((v) => (
                <TableRow key={v.id}>
                  <TableCell className="font-mono text-xs font-medium">
                    {v.key}
                  </TableCell>
                  <TableCell>
                    <EnvValueCell value={v.value} masked={v.masked} />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {v.teamWide && (
                        <Badge variant="muted" className="text-[10px]">
                          Team-wide
                        </Badge>
                      )}
                      {v.projects.length > 0 && (
                        <Badge variant="muted" className="text-[10px]">
                          {v.projects.length} project{v.projects.length > 1 ? "s" : ""}
                        </Badge>
                      )}
                      {v.environments.length > 0 && (
                        <Badge variant="muted" className="text-[10px]">
                          {v.environments.length} environment
                          {v.environments.length > 1 ? "s" : ""}
                        </Badge>
                      )}
                      {v.appIds.length > 0 && (
                        <Badge variant="muted" className="text-[10px]">
                          {v.appIds.length} linked
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setDialog({ editing: v })}
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
            </TableBody>
          </Table>
        </div>
      )}

      {dialog && (
        <SharedVarDialog
          key={dialog.editing?.id ?? "new"}
          open
          onOpenChange={(v) => !v && setDialog(null)}
          editing={dialog.editing}
          projects={projects}
          environments={environments}
        />
      )}
      <ConfirmAction
        open={deleteId !== null}
        onOpenChange={(v) => !v && setDeleteId(null)}
        title="Delete shared variable?"
        description="This removes the variable from every app it reaches. New deployments will no longer receive it."
        confirmLabel="Delete"
        successMessage="Shared variable deleted"
        onConfirm={async () => {
          const res = await gqlAction<{ deleteSharedVar: boolean }>(
            `mutation($id: String!) { deleteSharedVar(id: $id) }`,
            { id: deleteId! },
          );
          if (res.ok) router.refresh();
          return res;
        }}
      />
    </div>
  );
}

/**
 * Create/edit one shared variable + its three sharing modes. Exported so the
 * aggregate App tab can open it directly on a shared row (the spec's "dedicated
 * button to edit each variable" applies to shared vars too).
 */
export function SharedVarDialog({
  open,
  onOpenChange,
  editing,
  projects,
  environments,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: SharedVarDTO | null;
  projects: ProjectRef[];
  environments: TeamEnvironment[];
}) {
  const [key, setKey] = React.useState(editing?.key ?? "");
  const [value, setValue] = React.useState(editing?.value ?? "");
  const [secret, setSecret] = React.useState(editing?.type === "secret");
  const [targets, setTargets] = React.useState<EnvTarget[]>(
    editing?.targets ?? [...ALL_TARGETS],
  );
  const [teamWide, setTeamWide] = React.useState(editing?.teamWide ?? false);
  const [environmentIds, setEnvironmentIds] = React.useState<string[]>(
    editing?.environmentIds ?? [],
  );
  const [projectIds, setProjectIds] = React.useState<string[]>(
    editing?.projectIds ?? [],
  );
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();

  // A var must reach something: a sharing MODE, or — for a var migrated out of a
  // legacy shared group — the per-app links it already carries (the server accepts
  // those as reach too, so don't disable Save on them).
  const hasScope =
    teamWide ||
    environmentIds.length > 0 ||
    projectIds.length > 0 ||
    (editing?.appIds.length ?? 0) > 0;

  // Environments grouped by their owning project, for a readable checkbox list.
  const envsByProject = React.useMemo(() => {
    const m = new Map<string, TeamEnvironment[]>();
    for (const e of environments) {
      const arr = m.get(e.projectName) ?? [];
      arr.push(e);
      m.set(e.projectName, arr);
    }
    return [...m.entries()];
  }, [environments]);

  function submit() {
    startTransition(async () => {
      const res = await gqlAction<{ saveSharedVar: { id: string } }>(
        `mutation($input: SaveSharedVarInput!) { saveSharedVar(input: $input) { id } }`,
        {
          input: {
            id: editing?.id,
            key,
            value,
            type: secret ? "secret" : "plain",
            targets,
            teamWide,
            environmentIds,
            projectIds,
          },
        },
      );
      if (res.ok) {
        toast.success(editing ? "Shared variable updated" : "Shared variable created");
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit shared variable" : "New shared variable"}
          </DialogTitle>
          <DialogDescription>
            One variable, shared by environment, project, or with the whole team.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <FieldLabel info="The variable's name, exposed to apps at runtime. It can't be renamed once created.">
              Key
            </FieldLabel>
            <Input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="DATABASE_URL"
              className="font-mono text-sm"
              disabled={!!editing}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Value</label>
            <Textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={editing ? "Enter a new value" : "value"}
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <FieldLabel info="The runtimes this variable applies to. A deployment only receives it for its own environment.">
              Environments
            </FieldLabel>
            <div className="flex flex-wrap gap-4">
              {ALL_TARGETS.map((t) => (
                <label key={t} className="flex cursor-pointer items-center gap-2 text-sm capitalize">
                  <Checkbox
                    checked={targets.includes(t)}
                    onCheckedChange={() =>
                      setTargets((cur) =>
                        cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t],
                      )
                    }
                  />
                  {t}
                </label>
              ))}
            </div>
          </div>

          {/* --- Sharing modes (≥1 required) --- */}
          <div className="space-y-3 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between">
              <FieldLabel info="Share this variable with every app in the team, regardless of project or environment.">
                Team-wide
              </FieldLabel>
              <Switch checked={teamWide} onCheckedChange={setTeamWide} />
            </div>

            <div className="space-y-2">
              <FieldLabel info="Share with every app in the selected projects (a whitelist).">
                Projects
              </FieldLabel>
              {projects.length === 0 ? (
                <p className="text-xs text-muted-foreground">No projects yet.</p>
              ) : (
                <div className="grid max-h-40 grid-cols-1 gap-1 overflow-y-auto rounded-lg border border-border p-2 sm:grid-cols-2">
                  {projects.map((p) => (
                    <label
                      key={p.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent"
                    >
                      <Checkbox
                        checked={projectIds.includes(p.id)}
                        onCheckedChange={() =>
                          setProjectIds((cur) =>
                            cur.includes(p.id)
                              ? cur.filter((x) => x !== p.id)
                              : [...cur, p.id],
                          )
                        }
                      />
                      <span className="truncate">{p.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <FieldLabel info="Share with every app that lives in the selected environments.">
                Environments (by project)
              </FieldLabel>
              {environments.length === 0 ? (
                <p className="text-xs text-muted-foreground">No environments yet.</p>
              ) : (
                <div className="max-h-48 space-y-2 overflow-y-auto rounded-lg border border-border p-2">
                  {envsByProject.map(([projectName, envs]) => (
                    <div key={projectName} className="space-y-1">
                      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {projectName}
                      </p>
                      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                        {envs.map((e) => (
                          <label
                            key={e.id}
                            className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent"
                          >
                            <Checkbox
                              checked={environmentIds.includes(e.id)}
                              onCheckedChange={() =>
                                setEnvironmentIds((cur) =>
                                  cur.includes(e.id)
                                    ? cur.filter((x) => x !== e.id)
                                    : [...cur, e.id],
                                )
                              }
                            />
                            <span className="truncate">{e.name}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {!hasScope && (
              <p className="text-xs text-muted-foreground">
                Pick at least one environment, project, or team-wide.
              </p>
            )}
            {(editing?.appIds.length ?? 0) > 0 && (
              <p className="text-xs text-muted-foreground">
                Also linked directly to {editing!.appIds.length} app
                {editing!.appIds.length > 1 ? "s" : ""} — unlink from an app&apos;s
                Environment tab.
              </p>
            )}
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <div>
              <p className="text-sm font-medium">Secret</p>
              <p className="text-xs text-muted-foreground">
                Hide the value in the UI after saving.
              </p>
            </div>
            <Switch checked={secret} onCheckedChange={setSecret} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={pending || !key.trim() || !hasScope || targets.length === 0}
          >
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
