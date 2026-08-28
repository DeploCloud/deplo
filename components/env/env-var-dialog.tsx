"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import {
  SharedVarWizardBody,
  type ProjectRef,
  type TeamRef,
} from "@/components/env/shared-var-wizard";
import type { EnvVarDTO } from "@/lib/types";
import type { AppSharedVarDTO } from "@/lib/data/shared-vars";
import type { TeamEnvironment } from "@/lib/data/environments";

/**
 * A shared var as the LINK rows read it: everything but the value.
 */
type LinkableSharedVar = Omit<AppSharedVarDTO, "value">;

/**
 * Add/edit an app's environment variable. Editing shows a single form; adding
 * shows two tabs - "Standalone" (a multi-row editor that also accepts a pasted
 * `.env`) and "Shared" (link existing shared variables to this app).
 */
export function EnvVarDialog({
  open,
  onOpenChange,
  appId,
  appName,
  editing,
  sharedVars,
  canCreateShared = false,
  projects = [],
  environments = [],
  teams = [],
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  appId: string;
  /** Named on the "This app" destination of the shared-variable panel. */
  appName?: string;
  editing: EnvVarDTO | null;
  /** In-scope shared vars for this app; lazy-fetched when omitted. */
  sharedVars?: LinkableSharedVar[];
  /** `manage_env` held TEAM-WIDE - what creating a shared variable needs. */
  canCreateShared?: boolean;
  projects?: ProjectRef[];
  environments?: TeamEnvironment[];
  teams?: TeamRef[];
}) {
  // A secret has no edit form: it is write-only, and the pencil that opens this is
  // already disabled for a secret row (EnvEditButton).
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
      appName={appName}
      sharedVars={sharedVars}
      canCreateShared={canCreateShared}
      projects={projects}
      environments={environments}
      teams={teams}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Edit one existing standalone variable                               */
/* ------------------------------------------------------------------ */

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
  // Only a PLAIN var reaches this form (a secret is write-only and frozen), so
  // the value prefills with the real thing. The Secret switch below still
  // promotes one - hardening is the one type change that stays open.
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
    // Closes on the click; a rename that clashes reopens it on what was typed.
    onOpenChange(false);
    startTransition(async () => {
      // A rename moves the row to its new key FIRST - it's keyed by id, so it can't clash
      // with the value upsert below (which finds the row by (appId, key), and by then the
      // row already lives at the new key).
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
      // No `targets`: an App has no Environment of its own - it inherits exactly
      // one from its Project, so the server defaults every variable to every runtime.
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
              {/* Focus lands on the value, not the key: an edit far more often
                  changes the value than renames, and it keeps the Dialog's initial
                  focus off the info button next to the Key label. */}
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

/* ------------------------------------------------------------------ */
/* Add: Standalone (multi-row / paste .env) + Shared tabs              */
/* ------------------------------------------------------------------ */

const ADD_TABS = ["standalone", "shared"] as const;
type AddTab = (typeof ADD_TABS)[number];

/** The two tabs plus the shared-variable creator they lead to, as one track. */
const ADD_PANELS = [...ADD_TABS, "new-shared"] as const;
type AddPanel = (typeof ADD_PANELS)[number];

const PANEL_LABEL: Record<AddPanel, string> = {
  standalone: "Standalone",
  shared: "Shared",
  "new-shared": "New shared variable",
};

/**
 * Standalone, Shared and the shared-variable creator, as three panels on ONE
 * horizontal track that slides between them; the modal's height eases to
 * whichever panel is showing, so the slide glides instead of jumping.
 */
function AddDialog({
  open,
  onOpenChange,
  appId,
  appName,
  sharedVars,
  canCreateShared,
  projects,
  environments,
  teams,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  appId: string;
  appName?: string;
  sharedVars?: LinkableSharedVar[];
  canCreateShared: boolean;
  projects: ProjectRef[];
  environments: TeamEnvironment[];
  teams: TeamRef[];
}) {
  const [tab, setTab] = React.useState<AddTab>("standalone");
  // The creator is not a tab - it is where the Shared tab's button leads, and
  // Back returns to it.
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
          {/* One chrome row either way, so nothing jumps while the track moves:
              the segmented control, or the way back from the creator. */}
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
              // A segmented control on a track - the same shape the app wears
              // elsewhere, so the idle half still reads as a place you can go.
              <TabsList className="grid h-auto w-full grid-cols-2 rounded-lg border border-border bg-secondary/40 p-1">
                <TabsTrigger
                  value="standalone"
                  className="data-[state=active]:bg-background data-[state=active]:shadow-sm"
                >
                  <Plus />
                  Standalone
                </TabsTrigger>
                <TabsTrigger
                  value="shared"
                  className="data-[state=active]:bg-background data-[state=active]:shadow-sm"
                >
                  <Share2 />
                  Shared
                </TabsTrigger>
              </TabsList>
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
                    teams={teams}
                    editing={null}
                    apps={[]}
                    projects={projects}
                    environments={environments}
                    appContext={{ id: appId, name: appName ?? "this app" }}
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

/** The row editor itself lives in `env-rows-editor.tsx` - Add preview override
 *  uses the very same one. */

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

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    save();
  }

  function save() {
    // The panel closes on the click and the write settles behind it: what makes this
    // slow is not the insert but the refresh that re-reads every variable of the app
    // afterwards.
    onDone();
    void (async () => {
      // No `targets` on either path: an App has no Environment of its own - it
      // inherits exactly one from its Project, so the server defaults every
      // variable to every runtime.
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
      // Multiple rows → the additive importEnv path (all land as plain; flip to
      // secret from the table afterwards).
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
        // A secret cannot be overwritten, so a pasted line naming one is left
        // alone. Say so: a variable that quietly did not import is worse than
        // one that refused out loud.
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
      {/* The body - the only thing that scrolls. */}
      <div
        className={cn("space-y-4 overflow-y-auto px-6 py-4", PANEL_BODY_MAX)}
      >
        <EnvRowsEditor rows={rows} onChange={setRows} />

        {filled.length > 1 ? (
          <p className="flex items-start gap-2 rounded-lg border border-border bg-secondary/30 px-3 py-2.5 text-xs text-muted-foreground">
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
        {/* The paste shortcut is the fastest way in and nothing else announces
            it: the Key input explodes a whole .env into rows on paste. */}
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
  /** This tab is mounted even while off-screen (for the slide); only reach for
   *  the network once it has actually been opened. */
  active: boolean;
  canCreate: boolean;
  onCreate: () => void;
  onClose: () => void;
}) {
  const [fetched, setFetched] = React.useState<LinkableSharedVar[] | null>(
    null,
  );
  const [query, setQuery] = React.useState("");
  // The prop wins whenever there is one, and it CHANGES: creating a shared
  // variable from here refreshes the RSC, and this list has to follow rather
  // than keep the copy it mounted with.
  const vars = sharedVars ?? fetched;

  // Lazy-fetch when the caller didn't pass the in-scope set (aggregate view),
  // but not before this tab is opened, so a dialog left on Standalone never
  // queries for shared vars it won't show. Re-runs whenever the tab is opened,
  // which is also how a variable created next door lands in the list.
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
  // Case-insensitive substring match on the key - the only thing a row shows and
  // the only thing you'd search a variable by.
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
              // Same table grammar as the Standalone tab: a labelled header, one
              // row per variable, no card floating loose inside a card.
              <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                <div className="flex items-center justify-between bg-secondary/40 px-3 py-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
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

      {/* Each toggle already saved itself - Done just closes, it doesn't commit. */}
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

/** Why a not-yet-added variable is suggested here - its availability scope. */
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

  // Every shared variable is OPT-IN (ADR-0012): added ⇒ removable, never a
  // disabled "auto-applied" state. The scope only explains why it's suggested.
  const hint = sharedVar.scope ? SCOPE_HINT[sharedVar.scope] : null;

  // The one exception to the opt-in (ADR-0027): it is already in this app, with no
  // link, and adding it here would only be a second copy of a decision already made.
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
    <div className="flex items-center justify-between gap-3 px-3 py-2.5 transition-colors hover:bg-accent/30">
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

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */
