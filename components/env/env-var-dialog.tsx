"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2, Share2, ArrowUpRight } from "lucide-react";
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
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/empty-state";
import { FieldLabel } from "@/components/ui/info-tip";
import { gql, gqlAction } from "@/lib/graphql-client";
import { parseEnv } from "@/components/env/env-parse";
import type { EnvTarget, EnvVarDTO } from "@/lib/types";
import type { AppSharedVarDTO } from "@/lib/data/shared-vars";

const ALL_TARGETS: EnvTarget[] = ["production", "preview", "development"];

/** Human labels for how a shared var reaches an app. */
const VIA_LABEL: Record<string, string> = {
  teamWide: "Team-wide",
  environment: "Environment",
  project: "Project",
  link: "Linked",
};

/**
 * Add/edit an app's environment variable. Editing shows a single form; adding
 * shows two tabs — "Standalone" (a multi-row editor that also accepts a pasted
 * `.env`) and "Shared" (link existing shared variables to this app).
 */
export function EnvVarDialog({
  open,
  onOpenChange,
  appId,
  editing,
  sharedVars,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  appId: string;
  editing: EnvVarDTO | null;
  /** In-scope shared vars for this app; lazy-fetched when omitted. */
  sharedVars?: AppSharedVarDTO[];
}) {
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
  const [value, setValue] = React.useState("");
  const [secret, setSecret] = React.useState(editing.type === "secret");
  const [targets, setTargets] = React.useState<EnvTarget[]>(editing.targets);
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();

  function submit() {
    startTransition(async () => {
      const res = await gqlAction<{ upsertEnv: { id: string } }>(
        `mutation($input: UpsertEnvInput!) { upsertEnv(input: $input) { id } }`,
        {
          input: {
            appId,
            key: editing.key,
            value,
            targets,
            type: secret ? "secret" : "plain",
          },
        },
      );
      if (res.ok) {
        toast.success("Variable updated");
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit variable</DialogTitle>
          <DialogDescription>
            Update the value or environments for this variable.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <FieldLabel info="The variable's name, exposed to your app at runtime. It can't be renamed once created.">
              Key
            </FieldLabel>
            <Input value={editing.key} className="font-mono text-sm" disabled />
          </div>
          <div className="space-y-2">
            <Label>Value</Label>
            <Textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Enter a new value"
              rows={3}
            />
          </div>
          <TargetsField targets={targets} onToggle={(t) => setTargets(toggle(targets, t))} />
          <SecretRow secret={secret} onChange={setSecret} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Add: Standalone (multi-row / paste .env) + Shared tabs              */
/* ------------------------------------------------------------------ */

function AddDialog({
  open,
  onOpenChange,
  appId,
  sharedVars,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  appId: string;
  sharedVars?: AppSharedVarDTO[];
}) {
  const [tab, setTab] = React.useState<"standalone" | "shared">("standalone");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add variables</DialogTitle>
          <DialogDescription>
            Add variables to this app, or link existing shared variables.
          </DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="standalone">
              <Plus className="size-4" />
              Standalone
            </TabsTrigger>
            <TabsTrigger value="shared">
              <Share2 className="size-4" />
              Shared
            </TabsTrigger>
          </TabsList>
          <TabsContent value="standalone">
            <StandaloneTab appId={appId} onDone={() => onOpenChange(false)} />
          </TabsContent>
          <TabsContent value="shared">
            <SharedTab appId={appId} sharedVars={sharedVars} onClose={() => onOpenChange(false)} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

type Row = { key: string; value: string };

function StandaloneTab({ appId, onDone }: { appId: string; onDone: () => void }) {
  const [rows, setRows] = React.useState<Row[]>([{ key: "", value: "" }]);
  const [targets, setTargets] = React.useState<EnvTarget[]>([...ALL_TARGETS]);
  const [secret, setSecret] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();

  const filled = rows.filter((r) => r.key.trim() !== "");

  function setRow(i: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function removeRow(i: number) {
    setRows((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev));
  }
  function addRow() {
    setRows((prev) => [...prev, { key: "", value: "" }]);
  }

  // Pasting `.env` content into a key field explodes into editable rows.
  function onPaste(i: number, e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text");
    const parsed = parseEnv(text);
    // Only intercept multi-var / KEY=VALUE pastes; a plain value pastes normally.
    if (parsed.length === 0 || (parsed.length === 1 && !text.includes("\n"))) return;
    e.preventDefault();
    setRows((prev) => {
      const kept = prev.filter((r, idx) => idx !== i && r.key.trim() !== "");
      const merged = [...kept];
      for (const p of parsed) {
        const at = merged.findIndex((r) => r.key === p.key);
        if (at >= 0) merged[at] = p;
        else merged.push(p);
      }
      return merged.length ? merged : [{ key: "", value: "" }];
    });
  }

  function save() {
    startTransition(async () => {
      if (filled.length === 1) {
        const res = await gqlAction<{ upsertEnv: { id: string } }>(
          `mutation($input: UpsertEnvInput!) { upsertEnv(input: $input) { id } }`,
          {
            input: {
              appId,
              key: filled[0].key.trim(),
              value: filled[0].value,
              targets,
              type: secret ? "secret" : "plain",
            },
          },
        );
        if (res.ok) {
          toast.success("Variable added");
          onDone();
          router.refresh();
        } else {
          toast.error(res.error);
        }
        return;
      }
      // Multiple rows → the additive importEnv path (all land as plain; flip to
      // secret from the table afterwards).
      const blob = filled.map((r) => `${r.key.trim()}=${r.value}`).join("\n");
      const res = await gqlAction<{ importEnv: number }, number>(
        `mutation($appId: String!, $blob: String!, $targets: [EnvTarget!]!) {
          importEnv(appId: $appId, blob: $blob, targets: $targets)
        }`,
        { appId, blob, targets },
        (d) => d.importEnv,
      );
      if (res.ok && res.data != null) {
        toast.success(`Added ${res.data} variable(s)`);
        onDone();
        router.refresh();
      } else if (!res.ok) {
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="space-y-4 pt-2">
      <p className="text-xs text-muted-foreground">
        Enter one or more variables, or paste a full{" "}
        <code className="font-mono">.env</code> into a key field to fill the rows.
      </p>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              value={r.key}
              onChange={(e) => setRow(i, { key: e.target.value })}
              onPaste={(e) => onPaste(i, e)}
              placeholder="KEY"
              className="font-mono text-xs"
            />
            <Input
              value={r.value}
              onChange={(e) => setRow(i, { value: e.target.value })}
              placeholder="value"
              className="text-xs"
            />
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-muted-foreground hover:text-destructive"
              onClick={() => removeRow(i)}
              disabled={rows.length === 1}
              aria-label="Remove row"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
        <Button variant="ghost" size="sm" onClick={addRow} className="text-muted-foreground">
          <Plus className="size-4" />
          Add another
        </Button>
      </div>
      <TargetsField targets={targets} onToggle={(t) => setTargets(toggle(targets, t))} />
      {filled.length > 1 ? (
        <p className="text-xs text-muted-foreground">
          Pasted variables are added as plain — flip individual ones to secret from
          the table.
        </p>
      ) : (
        <SecretRow secret={secret} onChange={setSecret} />
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button onClick={save} disabled={pending || filled.length === 0 || targets.length === 0}>
          {pending ? "Saving…" : filled.length > 1 ? `Add ${filled.length}` : "Add"}
        </Button>
      </DialogFooter>
    </div>
  );
}

function SharedTab({
  appId,
  sharedVars,
  onClose,
}: {
  appId: string;
  sharedVars?: AppSharedVarDTO[];
  onClose: () => void;
}) {
  const [vars, setVars] = React.useState<AppSharedVarDTO[] | null>(
    sharedVars ?? null,
  );

  // Lazy-fetch when the caller didn't pass the in-scope set (aggregate view).
  React.useEffect(() => {
    if (vars !== null) return;
    let alive = true;
    gql<{ sharedVarsForApp: AppSharedVarDTO[] }>(
      `query($appId: String!) {
        sharedVarsForApp(appId: $appId) { id key masked type targets via applied inherited linked }
      }`,
      { appId },
    )
      .then((d) => alive && setVars(d.sharedVarsForApp))
      .catch(() => alive && setVars([]));
    return () => {
      alive = false;
    };
  }, [appId, vars]);

  return (
    <div className="space-y-4 pt-2">
      {vars === null ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
      ) : vars.length === 0 ? (
        <EmptyState
          icon={Share2}
          title="No shared variables"
          description="Create shared variables on the Variables page to reuse them across apps."
        />
      ) : (
        <div className="space-y-2">
          {vars.map((v) => (
            <SharedVarLinkRow key={v.id} appId={appId} sharedVar={v} />
          ))}
        </div>
      )}
      <DialogFooter className="sm:justify-between">
        <Button variant="outline" size="sm" asChild>
          <Link href="/variables?tab=shared">
            Create &amp; manage
            <ArrowUpRight className="size-4" />
          </Link>
        </Button>
        <Button variant="outline" onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}

function SharedVarLinkRow({
  appId,
  sharedVar,
}: {
  appId: string;
  sharedVar: AppSharedVarDTO;
}) {
  const router = useRouter();
  const [linked, setLinked] = React.useState(sharedVar.linked);
  const [pending, startTransition] = React.useTransition();
  // Auto-applied via a mode → can't be unlinked from the app; shown checked+disabled.
  const on = sharedVar.inherited || linked;

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
        toast.success(next ? "Linked" : "Unlinked");
        router.refresh();
      } else {
        setLinked(!next);
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
      <div className="min-w-0 space-y-1">
        <p className="truncate font-mono text-xs font-medium">{sharedVar.key}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="muted" className="text-[10px]">
            {VIA_LABEL[sharedVar.via] ?? "Shared"}
          </Badge>
          {sharedVar.inherited && (
            <span className="text-[10px] text-muted-foreground">
              Auto-applied
            </span>
          )}
        </div>
      </div>
      <Switch
        checked={on}
        onCheckedChange={toggle}
        disabled={pending || sharedVar.inherited}
        aria-label={on ? "Unlink" : "Link"}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

function toggle(list: EnvTarget[], t: EnvTarget): EnvTarget[] {
  return list.includes(t) ? list.filter((x) => x !== t) : [...list, t];
}

function TargetsField({
  targets,
  onToggle,
}: {
  targets: EnvTarget[];
  onToggle: (t: EnvTarget) => void;
}) {
  return (
    <div className="space-y-2">
      <FieldLabel info="The environments this variable is injected into. A deployment only receives variables enabled for its environment.">
        Environments
      </FieldLabel>
      <div className="flex flex-wrap gap-4">
        {ALL_TARGETS.map((t) => (
          <label key={t} className="flex cursor-pointer items-center gap-2 text-sm capitalize">
            <Checkbox checked={targets.includes(t)} onCheckedChange={() => onToggle(t)} />
            {t}
          </label>
        ))}
      </div>
    </div>
  );
}

function SecretRow({
  secret,
  onChange,
}: {
  secret: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border p-3">
      <div>
        <p className="text-sm font-medium">Secret</p>
        <p className="text-xs text-muted-foreground">
          Hide the value in the UI after saving.
        </p>
      </div>
      <Switch checked={secret} onCheckedChange={onChange} />
    </div>
  );
}
