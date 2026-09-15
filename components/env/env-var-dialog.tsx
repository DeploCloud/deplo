"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import {
  Loader2,
  Plus,
  Trash2,
  Share2,
  ChevronLeft,
  Info,
  Search,
  Check,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tabs,
  SegmentedTabsList,
  SegmentedTabsTrigger,
} from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { FieldLabel } from "@/components/ui/info-tip";
import { gql, gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";
import { envNameLooksSensitive } from "@/lib/env-secret-name";
import { KEY_RE } from "@/components/env/env-parse";
import {
  EnvRowsEditor,
  filledRows,
  invalidRows,
  type EnvRow,
} from "@/components/env/env-rows-editor";
import { SecretRow } from "@/components/env/secret-row";
import {
  SlidingPanels,
  PANEL_BODY_MAX,
} from "@/components/shared/sliding-panels";
import type {
  AppRef,
  ProjectRef,
  TeamRef,
} from "@/components/env/shared-var-wizard/types";
import { SharedVarWizardBody } from "@/components/env/shared-var-wizard/wizard-body";
import type { EnvVarDTO } from "@/lib/types/env";
import type { AppSharedVarDTO } from "@/lib/data/shared-vars/app-view";
import type { TeamEnvironment } from "@/lib/data/environments";

type LinkableSharedVar = Omit<AppSharedVarDTO, "value">;

export function EnvVarDialog({
  open,
  onOpenChange,
  appId,
  editing,
  sharedVars,
  canCreateShared = false,
  apps = [],
  projects = [],
  environments = [],
  teams = [],
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  appId: string;
  editing: EnvVarDTO | null;
  sharedVars?: LinkableSharedVar[];
  canCreateShared?: boolean;
  apps?: AppRef[];
  projects?: ProjectRef[];
  environments?: TeamEnvironment[];
  teams?: TeamRef[];
}) {
  if (editing?.type === "secret") return null;
  if (editing) {
    return (
      <EditForm
        open={open}
        onOpenChange={onOpenChange}
        appId={appId}
        editing={editing}
      />
    );
  }
  return (
    <AddDialog
      open={open}
      onOpenChange={onOpenChange}
      appId={appId}
      sharedVars={sharedVars}
      canCreateShared={canCreateShared}
      apps={apps}
      projects={projects}
      environments={environments}
      teams={teams}
    />
  );
}

function EditForm({
  open,
  onOpenChange,
  appId,
  editing,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  appId: string;
  editing: EnvVarDTO;
}) {
  const [key, setKey] = React.useState(editing.key);
  const [value, setValue] = React.useState(editing.value);
  const [secret, setSecret] = React.useState(editing.type === "secret");
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();

  const trimmedKey = key.trim();
  const keyValid = KEY_RE.test(trimmedKey);
  const renamed = trimmedKey !== editing.key;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit();
  }

  function submit() {
    onOpenChange(false);
    startTransition(async () => {
      // The rename goes first: it is keyed by id, so it cannot clash with the upsert below.
      if (renamed) {
        const r = await gqlAction<{ renameEnv: { id: string } }>(
          `mutation($id: String!, $newKey: String!) {
            renameEnv(id: $id, newKey: $newKey) { id }
          }`,
          { id: editing.id, newKey: trimmedKey },
        );
        if (!r.ok) {
          onOpenChange(true);
          toast.error(r.error);
          return;
        }
      }
      // No `targets`: the server defaults every variable to every runtime.
      const res = await gqlAction<{ upsertEnv: { id: string } }>(
        `mutation($input: UpsertEnvInput!) { upsertEnv(input: $input) { id } }`,
        {
          input: {
            appId,
            key: trimmedKey,
            value,
            type: secret ? "secret" : "plain",
          },
        },
      );
      if (res.ok) toast.success("Variable updated");
      else {
        onOpenChange(true);
        toast.error(res.error);
      }
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit variable</DialogTitle>
          <DialogDescription>
            Update this variable&apos;s name or value.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className="space-y-4">
            <div className="space-y-2">
              <FieldLabel
                info="The variable's name, exposed to your app during builds and at runtime. Renaming it takes effect on the next deploy."
                docs="env.overview"
              >
                Key
              </FieldLabel>
              <Input
                value={key}
                onChange={(e) => setKey(e.target.value)}
                spellCheck={false}
                aria-invalid={trimmedKey !== "" && !keyValid}
                className={cn(
                  "font-mono text-sm",
                  trimmedKey !== "" &&
                    !keyValid &&
                    "border-destructive text-destructive focus-visible:ring-destructive",
                )}
              />
              {trimmedKey !== "" && !keyValid && (
                <p className="text-xs text-destructive">
                  Names must start with a letter or underscore and contain only
                  letters, digits and underscores.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Value</Label>
              <Textarea
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="Enter a new value"
                rows={3}
                autoFocus
              />
            </div>
            <SecretRow secret={secret} onChange={setSecret} />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !keyValid}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const ADD_TABS = ["standalone", "shared"] as const;
type AddTab = (typeof ADD_TABS)[number];

const ADD_PANELS = [...ADD_TABS, "new-shared"] as const;
type AddPanel = (typeof ADD_PANELS)[number];

const PANEL_LABEL: Record<AddPanel, string> = {
  standalone: "Standalone",
  shared: "Shared",
  "new-shared": "New shared variable",
};

function AddDialog({
  open,
  onOpenChange,
  appId,
  sharedVars,
  canCreateShared,
  apps,
  projects,
  environments,
  teams,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  appId: string;
  sharedVars?: LinkableSharedVar[];
  canCreateShared: boolean;
  apps: AppRef[];
  projects: ProjectRef[];
  environments: TeamEnvironment[];
  teams: TeamRef[];
}) {
  const [tab, setTab] = React.useState<AddTab>("standalone");
  const [creating, setCreating] = React.useState(false);
  const panel: AddPanel = creating ? "new-shared" : tab;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        selfManaged
        className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl"
      >
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle>Add environment variables</DialogTitle>
          <DialogDescription>
            Add variables to this app, or link existing shared variables.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as AddTab)}
          className="flex min-h-0 flex-col"
        >
          <div className="border-b border-border px-6 pb-4">
            {creating ? (
              <Button
                variant="ghost"
                size="sm"
                className="-ml-2 h-9 text-muted-foreground hover:text-foreground"
                onClick={() => setCreating(false)}
              >
                <ChevronLeft className="size-4" />
                Shared variables
              </Button>
            ) : (
              <SegmentedTabsList>
                <SegmentedTabsTrigger value="standalone">
                  <Plus />
                  Standalone
                </SegmentedTabsTrigger>
                <SegmentedTabsTrigger value="shared">
                  <Share2 />
                  Shared
                </SegmentedTabsTrigger>
              </SegmentedTabsList>
            )}
          </div>

          <SlidingPanels
            panels={ADD_PANELS}
            current={panel}
            labelFor={(p) => PANEL_LABEL[p]}
            render={(p) =>
              p === "standalone" ? (
                <StandaloneTab
                  appId={appId}
                  onDone={() => onOpenChange(false)}
                />
              ) : p === "shared" ? (
                <SharedTab
                  appId={appId}
                  sharedVars={sharedVars}
                  active={panel === "shared"}
                  canCreate={canCreateShared}
                  onCreate={() => setCreating(true)}
                  onClose={() => onOpenChange(false)}
                />
              ) : (
                canCreateShared && (
                  <SharedVarWizardBody
                    nested
                    teams={teams}
                    editing={null}
                    apps={apps}
                    projects={projects}
                    environments={environments}
                    defaultAppIds={[appId]}
                    onOpenChange={setCreating}
                  />
                )
              )
            }
          />
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function StandaloneTab({
  appId,
  onDone,
}: {
  appId: string;
  onDone: () => void;
}) {
  const [rows, setRows] = React.useState<EnvRow[]>([{ key: "", value: "" }]);
  const [secret, setSecret] = React.useState(false);
  const router = useRouter();

  const filled = filledRows(rows);
  const invalid = invalidRows(rows);
  const looksSecret =
    !secret &&
    filled.length === 1 &&
    envNameLooksSensitive(filled[0].key.trim());

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    save();
  }

  function save() {
    onDone();
    void (async () => {
      if (filled.length === 1) {
        const res = await gqlAction<{ upsertEnv: { id: string } }>(
          `mutation($input: UpsertEnvInput!) { upsertEnv(input: $input) { id } }`,
          {
            input: {
              appId,
              key: filled[0].key.trim(),
              value: filled[0].value,
              type: secret ? "secret" : "plain",
            },
          },
        );
        if (res.ok) toast.success("Variable added");
        else toast.error(res.error);
        router.refresh();
        return;
      }
      const blob = filled.map((r) => `${r.key.trim()}=${r.value}`).join("\n");
      type ImportResult = { added: number; skippedSecrets: number };
      const res = await gqlAction<{ importEnv: ImportResult }, ImportResult>(
        `mutation($appId: String!, $blob: String!) {
          importEnv(appId: $appId, blob: $blob) { added skippedSecrets }
        }`,
        { appId, blob },
        (d) => d.importEnv,
      );
      if (res.ok && res.data != null) {
        const { added, skippedSecrets } = res.data;
        toast.success(
          skippedSecrets > 0
            ? `Added ${added} variable(s), ${skippedSecrets} secret(s) skipped`
            : `Added ${added} variable(s)`,
        );
      } else if (!res.ok) {
        toast.error(res.error);
      }
      router.refresh();
    })();
  }

  return (
    <form onSubmit={onSubmit}>
      <div
        className={cn("space-y-4 overflow-y-auto px-6 py-4", PANEL_BODY_MAX)}
      >
        <EnvRowsEditor rows={rows} onChange={setRows} />

        {looksSecret && (
          <p className="flex items-start gap-2 rounded-lg border border-border bg-surface px-3 py-2.5 text-xs text-muted-foreground">
            <Info className="mt-px size-3.5 shrink-0" />
            <span>
              “{filled[0].key.trim()}” reads like a credential. Turn on Secret
              below to store it write-only.
            </span>
          </p>
        )}

        {filled.length > 1 ? (
          <p className="flex items-start gap-2 rounded-lg border border-border bg-surface px-3 py-2.5 text-xs text-muted-foreground">
            <Info className="mt-px size-3.5 shrink-0" />
            <span>
              Pasted variables are added as plain - flip individual ones to
              secret from the table.
            </span>
          </p>
        ) : (
          <SecretRow secret={secret} onChange={setSecret} />
        )}
      </div>

      <DialogFooter className="items-center border-t border-border px-6 py-4 sm:justify-between">
        <p className="text-xs text-muted-foreground">
          or paste .env contents in the Key field
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onDone}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={filled.length === 0 || invalid.length > 0}
          >
            {filled.length > 1 ? `Add ${filled.length}` : "Add"}
          </Button>
        </div>
      </DialogFooter>
    </form>
  );
}

function SharedTab({
  appId,
  sharedVars,
  active,
  canCreate,
  onCreate,
  onClose,
}: {
  appId: string;
  sharedVars?: LinkableSharedVar[];
  active: boolean;
  canCreate: boolean;
  onCreate: () => void;
  onClose: () => void;
}) {
  const [fetched, setFetched] = React.useState<LinkableSharedVar[] | null>(
    null,
  );
  const [query, setQuery] = React.useState("");
  const vars = sharedVars ?? fetched;

  React.useEffect(() => {
    if (!active || sharedVars) return;
    let alive = true;
    gql<{ sharedVarsForApp: LinkableSharedVar[] }>(
      `query($appId: String!) {
        sharedVarsForApp(appId: $appId) {
          id key masked type targets linked inScope scope autoInject ownerTeamName
          updatedAt updatedBy { id name username avatarColor avatarUrl }
        }
      }`,
      { appId },
    )
      .then((d) => alive && setFetched(d.sharedVarsForApp))
      .catch(() => alive && setFetched([]));
    return () => {
      alive = false;
    };
  }, [appId, active, sharedVars]);

  const q = query.trim().toLowerCase();
  const filtered = vars?.filter((v) => v.key.toLowerCase().includes(q)) ?? null;

  return (
    <>
      <div
        className={cn("space-y-3 overflow-y-auto px-6 py-4", PANEL_BODY_MAX)}
      >
        {vars === null ? (
          <div className="space-y-2 py-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : vars.length === 0 ? (
          <EmptyState
            icon={Share2}
            title="No shared variables"
            docs="env.shared"
            description="One value, reused by as many apps as you like."
            className="py-10"
          />
        ) : (
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search shared variables"
                className="h-9 pl-8"
              />
            </div>
            {filtered && filtered.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No shared variables match “{query.trim()}”.
              </p>
            ) : (
              <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                <div className="flex items-center justify-between bg-surface px-3 py-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  <span>Shared variable</span>
                  <span aria-hidden />
                </div>
                {filtered!.map((v) => (
                  <SharedVarLinkRow key={v.id} appId={appId} sharedVar={v} />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <DialogFooter className="border-t border-border px-6 py-4">
        {canCreate && (
          <Button variant="outline" onClick={onCreate}>
            <Plus className="size-4" />
            New shared variable
          </Button>
        )}
        <Button onClick={onClose}>Done</Button>
      </DialogFooter>
    </>
  );
}

const SCOPE_HINT: Record<string, string> = {
  teamWide: "Shared with your team",
  project: "Shared with this app's project",
  environment: "Shared with this app's environment",
};

function SharedVarLinkRow({
  appId,
  sharedVar,
}: {
  appId: string;
  sharedVar: LinkableSharedVar;
}) {
  const router = useRouter();
  const [linked, setLinked] = React.useState(sharedVar.linked);
  const [pending, startTransition] = React.useTransition();

  function toggle(next: boolean) {
    setLinked(next);
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($varId: String!, $appId: String!, $linked: Boolean!) {
          setSharedVarAppLink(varId: $varId, appId: $appId, linked: $linked)
        }`,
        { varId: sharedVar.id, appId, linked: next },
      );
      if (res.ok) {
        toast.success(
          next
            ? "Added to this app"
            : sharedVar.autoInject
              ? `${sharedVar.key} now arrives from ${sharedVar.ownerTeamName ?? "an instance admin"}`
              : "Removed from this app",
        );
        router.refresh();
      } else {
        setLinked(!next);
        toast.error(res.error);
      }
    });
  }

  const hint = sharedVar.scope ? SCOPE_HINT[sharedVar.scope] : null;

  if (sharedVar.autoInject && !linked)
    return (
      <div className="flex items-center justify-between gap-3 px-3 py-2.5">
        <div className="min-w-0 space-y-1">
          <p className="truncate font-mono text-xs font-medium">
            {sharedVar.key}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="muted" className="gap-1 text-[10px] font-normal">
              <Check className="size-3" />
              Added
            </Badge>
            <span className="text-[10px] text-muted-foreground">
              Shared by {sharedVar.ownerTeamName ?? "an instance admin"}
            </span>
          </div>
        </div>
      </div>
    );

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5 transition-colors hover:bg-surface">
      <div className="min-w-0 space-y-1">
        <p className="truncate font-mono text-xs font-medium">
          {sharedVar.key}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {linked && (
            <Badge variant="muted" className="gap-1 text-[10px] font-normal">
              <Check className="size-3" />
              Added
            </Badge>
          )}
          <span className="text-[10px] text-muted-foreground">
            {hint ?? (linked ? "Added directly to this app" : "Not added")}
          </span>
        </div>
      </div>
      {linked ? (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => toggle(false)}
          disabled={pending}
          aria-label="Remove from this app"
          className="shrink-0 text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="size-4" />
        </Button>
      ) : (
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => toggle(true)}
          disabled={pending}
          aria-label="Add to this app"
          className="shrink-0"
        >
          <Plus className="size-4" />
        </Button>
      )}
    </div>
  );
}
