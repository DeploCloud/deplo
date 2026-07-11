"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Plus,
  Upload,
  Trash2,
  Pencil,
  Rows3,
  FileText,
  Share2,
  ArrowUpRight,
  Eye,
  EyeOff,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { FieldLabel } from "@/components/ui/info-tip";
import { EmptyState } from "@/components/shared/empty-state";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { EnvValueCell } from "@/components/env/env-value-cell";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";
import type { EnvTarget, EnvVarDTO } from "@/lib/types";
import type { ServiceSharedEnvGroupDTO } from "@/lib/data/shared-env";

const ALL_TARGETS: EnvTarget[] = ["production", "preview", "development"];

export function EnvManager({
  serviceId,
  vars,
  sharedGroups,
}: {
  serviceId: string;
  vars: EnvVarDTO[];
  sharedGroups: ServiceSharedEnvGroupDTO[];
}) {
  const [editing, setEditing] = React.useState<EnvVarDTO | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  const [deleteId, setDeleteId] = React.useState<string | null>(null);
  const [sharedOpen, setSharedOpen] = React.useState(false);
  // "table" → the per-row UI; "editor" → a raw .env text editor over all vars.
  const [mode, setMode] = React.useState<"table" | "editor">("table");
  const router = useRouter();

  const attachedGroups = sharedGroups.filter((g) => g.attached);
  // One read-only row per key contributed by an attached shared group.
  const sharedRows = attachedGroups.flatMap((g) =>
    g.keys.map((key) => ({ group: g, key })),
  );

  // Which plain rows are currently revealed. Secrets are never in this set —
  // they have no reveal path. "Reveal all" fills/clears it in one shot.
  const [revealedIds, setRevealedIds] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const revealableIds = vars.filter((v) => !v.masked).map((v) => v.id);
  const allRevealed =
    revealableIds.length > 0 && revealableIds.every((id) => revealedIds.has(id));

  function toggleReveal(id: string, next: boolean) {
    setRevealedIds((prev) => {
      const set = new Set(prev);
      if (next) set.add(id);
      else set.delete(id);
      return set;
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Environment Variables</h3>
          <p className="text-sm text-muted-foreground">
            Secret values are encrypted at rest and never shown again.
          </p>
        </div>
        {/* The Table / Editor switch stands alone in the top-right so it keeps
            its position when the table-mode actions below appear or vanish. */}
        <ViewToggle mode={mode} onChange={setMode} />
      </div>

      {mode === "table" && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {revealableIds.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setRevealedIds(
                  allRevealed ? new Set() : new Set(revealableIds),
                )
              }
            >
              {allRevealed ? (
                <EyeOff className="size-4" />
              ) : (
                <Eye className="size-4" />
              )}
              {allRevealed ? "Hide all" : "Reveal all"}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSharedOpen(true)}
          >
            <Share2 className="size-4" />
            Shared groups
            {attachedGroups.length > 0 && (
              <Badge variant="secondary" className="ml-1 text-[10px]">
                {attachedGroups.length}
              </Badge>
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setImportOpen(true)}
          >
            <Upload className="size-4" />
            Import .env
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setEditing(null);
              setAddOpen(true);
            }}
          >
            <Plus className="size-4" />
            Add
          </Button>
        </div>
      )}

      {mode === "editor" ? (
        <EnvEditor
          serviceId={serviceId}
          vars={vars}
          onDone={() => setMode("table")}
        />
      ) : vars.length === 0 && sharedRows.length === 0 ? (
        <EmptyState
          icon={Plus}
          title="No environment variables"
          description="Add variables to configure your app per environment."
        />
      ) : (
        <div className="rounded-xl border border-border">
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
              {vars.map((v) => (
                <TableRow key={v.id}>
                  <TableCell className="font-mono text-xs font-medium">
                    {v.key}
                  </TableCell>
                  <TableCell>
                    <EnvValueCell
                      value={v.value}
                      masked={v.masked}
                      revealed={revealedIds.has(v.id)}
                      onRevealedChange={(next) => toggleReveal(v.id, next)}
                    />
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
                        onClick={() => { setEditing(v); setAddOpen(true); }}
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
              {sharedRows.map(({ group, key }) => (
                <TableRow key={`${group.id}:${key}`}>
                  <TableCell className="font-mono text-xs font-medium">
                    <div className="flex items-center gap-2">
                      {key}
                      <Badge
                        variant="muted"
                        className="gap-1 text-[10px] font-normal"
                      >
                        <Share2 className="size-3" />
                        Shared · {group.name}
                      </Badge>
                    </div>
                  </TableCell>
                  <TableCell>
                    {/* Shared values are never exposed to the client. */}
                    <span className="text-xs text-muted-foreground">
                      managed in group
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {group.targets.map((t) => (
                        <Badge key={t} variant="muted" className="text-[10px] capitalize">
                          {t}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="link"
                      size="sm"
                      asChild
                      className="h-auto p-0 text-xs text-muted-foreground"
                    >
                      <Link href="/variables?tab=shared">Manage</Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <EnvDialog
        key={editing?.id ?? "new"}
        open={addOpen}
        onOpenChange={setAddOpen}
        serviceId={serviceId}
        editing={editing}
      />
      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        serviceId={serviceId}
      />
      <SharedGroupsDialog
        open={sharedOpen}
        onOpenChange={setSharedOpen}
        serviceId={serviceId}
        groups={sharedGroups}
      />
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

function EnvDialog({
  open,
  onOpenChange,
  serviceId,
  editing,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  serviceId: string;
  editing: EnvVarDTO | null;
}) {
  const [key, setKey] = React.useState(editing?.key ?? "");
  const [value, setValue] = React.useState("");
  // New variables are PLAIN by default; editing preserves the existing type.
  const [secret, setSecret] = React.useState(editing?.type === "secret");
  const [targets, setTargets] = React.useState<EnvTarget[]>(
    editing?.targets ?? ["production", "preview", "development"]
  );
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();

  function toggleTarget(t: EnvTarget) {
    setTargets((cur) =>
      cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]
    );
  }

  function submit() {
    startTransition(async () => {
      const res = await gqlAction<{ upsertEnv: { id: string } }>(
        `mutation($input: UpsertEnvInput!) { upsertEnv(input: $input) { id } }`,
        {
          input: {
            serviceId,
            key,
            value,
            targets,
            type: secret ? "secret" : "plain",
          },
        },
      );
      if (res.ok) {
        toast.success(editing ? "Variable updated" : "Variable added");
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
          <DialogTitle>{editing ? "Edit variable" : "Add variable"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Update the value or environments for this variable."
              : "Add a new environment variable to this service."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <FieldLabel info="The environment variable's name, exposed to your app at runtime. It can't be renamed once the variable is created.">
              Key
            </FieldLabel>
            <Input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="API_KEY"
              className="font-mono text-sm"
              disabled={!!editing}
            />
          </div>
          <div className="space-y-2">
            <Label>Value</Label>
            <Textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={editing ? "Enter a new value" : "value"}
              rows={3}
            />
          </div>
          <div className="space-y-2">
            <FieldLabel info="The environments this variable is injected into. A deployment only receives variables enabled for its environment.">
              Environments
            </FieldLabel>
            <div className="flex flex-wrap gap-4">
              {ALL_TARGETS.map((t) => (
                <label key={t} className="flex cursor-pointer items-center gap-2 text-sm capitalize">
                  <Checkbox
                    checked={targets.includes(t)}
                    onCheckedChange={() => toggleTarget(t)}
                  />
                  {t}
                </label>
              ))}
            </div>
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
          <Button onClick={submit} disabled={pending || !key.trim()}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportDialog({
  open,
  onOpenChange,
  serviceId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  serviceId: string;
}) {
  const [blob, setBlob] = React.useState("");
  const [targets, setTargets] = React.useState<EnvTarget[]>([
    "production",
    "preview",
    "development",
  ]);
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();

  function toggleTarget(t: EnvTarget) {
    setTargets((cur) =>
      cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]
    );
  }

  function submit() {
    startTransition(async () => {
      const res = await gqlAction<{ importEnv: number }, number>(
        `mutation($serviceId: String!, $blob: String!, $targets: [EnvTarget!]!) {
          importEnv(serviceId: $serviceId, blob: $blob, targets: $targets)
        }`,
        { serviceId, blob, targets },
        (d) => d.importEnv,
      );
      if (res.ok && res.data != null) {
        toast.success(`Imported ${res.data} variable(s)`);
        onOpenChange(false);
        setBlob("");
        router.refresh();
      } else if (!res.ok) {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import .env</DialogTitle>
          <DialogDescription>
            Paste the contents of a .env file. Each line is added as a plain
            variable — flip individual ones to secret afterwards.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Textarea
            value={blob}
            onChange={(e) => setBlob(e.target.value)}
            placeholder={"DATABASE_URL=postgres://...\nAPI_KEY=sk_live_..."}
            rows={8}
          />
          <div className="space-y-2">
            <FieldLabel info="The environments every imported variable is added to. Each parsed line is applied to all the environments you select here.">
              Environments
            </FieldLabel>
            <div className="flex flex-wrap gap-4">
              {ALL_TARGETS.map((t) => (
                <label key={t} className="flex cursor-pointer items-center gap-2 text-sm capitalize">
                  <Checkbox
                    checked={targets.includes(t)}
                    onCheckedChange={() => toggleTarget(t)}
                  />
                  {t}
                </label>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !blob.trim()}>
            {pending ? "Importing…" : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Compact attach/detach control for shared env groups. Replaces the old
 * standalone "Shared groups" section: every group gets a switch, and toggling
 * runs the same `setSharedEnvGroupAttachment` mutation (optimistically).
 */
function SharedGroupsDialog({
  open,
  onOpenChange,
  serviceId,
  groups,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  serviceId: string;
  groups: ServiceSharedEnvGroupDTO[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Shared groups</DialogTitle>
          <DialogDescription>
            Attach a reusable group to inject its variables alongside this
            project&apos;s own. They reach the runtimes the group targets.
          </DialogDescription>
        </DialogHeader>
        {groups.length === 0 ? (
          <EmptyState
            icon={Share2}
            title="No shared groups yet"
            description="Create a shared group from the Variables page to reuse the same variables across services."
          />
        ) : (
          <div className="space-y-2">
            {groups.map((g) => (
              <SharedGroupToggle key={g.id} serviceId={serviceId} group={g} />
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" size="sm" asChild>
            <Link href="/variables?tab=shared">
              Manage groups
              <ArrowUpRight className="size-4" />
            </Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SharedGroupToggle({
  serviceId,
  group,
}: {
  serviceId: string;
  group: ServiceSharedEnvGroupDTO;
}) {
  // Optimistic so the switch tracks instantly; refreshing the route
  // reconciles this to the durable value on the next render.
  const router = useRouter();
  const [attached, setAttached] = React.useState(group.attached);
  const [pending, startTransition] = React.useTransition();

  function toggle(next: boolean) {
    setAttached(next);
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($groupId: String!, $serviceId: String!, $attached: Boolean!) {
          setSharedEnvGroupAttachment(groupId: $groupId, serviceId: $serviceId, attached: $attached)
        }`,
        { groupId: group.id, serviceId, attached: next },
      );
      if (res.ok) {
        toast.success(next ? "Group attached" : "Group detached");
        router.refresh();
      } else {
        setAttached(!next);
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
      <div className="min-w-0 space-y-1.5">
        <p className="flex items-center gap-2 text-sm font-medium">
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
    </div>
  );
}

/** Segmented Table / Editor switch for the manager's two views. */
function ViewToggle({
  mode,
  onChange,
}: {
  mode: "table" | "editor";
  onChange: (m: "table" | "editor") => void;
}) {
  const opt = (m: "table" | "editor", Icon: typeof Rows3, label: string) => (
    <SimpleTooltip content={`${label} view`}>
      <button
        type="button"
        onClick={() => onChange(m)}
        aria-pressed={mode === m}
        className={cn(
          "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors",
          mode === m
            ? "bg-background font-medium text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <Icon className="size-3.5" />
        {label}
      </button>
    </SimpleTooltip>
  );
  return (
    <div className="inline-flex items-center rounded-lg border border-border bg-secondary/40 p-0.5">
      {opt("table", Rows3, "Table")}
      {opt("editor", FileText, "Editor")}
    </div>
  );
}

/** Serialise the vars to `.env` text. Plain values are shown verbatim; secret
 *  values come through as the mask (they are never revealed). */
function serializeEnv(vars: EnvVarDTO[]): string {
  return vars.map((v) => `${v.key}=${v.value}`).join("\n");
}

/** Parse `.env` text into KEY=VALUE pairs (skips blanks/comments; strips one
 *  layer of surrounding quotes). Validation of the key is done server-side. */
function parseEnv(text: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    if (!key) continue;
    out.push({ key, value });
  }
  return out;
}

/**
 * The ".env editor": one textarea over ALL of a service's variables. Plain
 * values are editable in place; secret values show as a mask and are preserved
 * unless changed (you can't read a secret you didn't set). Saving upserts every
 * line and deletes the ones removed — new vars are PLAIN and land in the chosen
 * default environments. Existing vars keep their own type + environments.
 */
function EnvEditor({
  serviceId,
  vars,
  onDone,
}: {
  serviceId: string;
  vars: EnvVarDTO[];
  onDone: () => void;
}) {
  const initial = React.useMemo(() => serializeEnv(vars), [vars]);
  const [text, setText] = React.useState(initial);
  const [targets, setTargets] = React.useState<EnvTarget[]>([...ALL_TARGETS]);
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();

  const hasSecrets = vars.some((v) => v.masked);
  const dirty = text !== initial;

  function toggleTarget(t: EnvTarget) {
    setTargets((cur) =>
      cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t],
    );
  }

  function save() {
    startTransition(async () => {
      const entries = parseEnv(text);
      const res = await gqlAction<{ setServiceEnv: number }, number>(
        `mutation($serviceId: String!, $entries: [EnvEntryInput!]!, $defaultTargets: [EnvTarget!]!) {
          setServiceEnv(serviceId: $serviceId, entries: $entries, defaultTargets: $defaultTargets)
        }`,
        { serviceId, entries, defaultTargets: targets },
        (d) => d.setServiceEnv,
      );
      if (res.ok) {
        toast.success("Environment saved");
        router.refresh();
        onDone();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Edit every variable as a <code className="font-mono">.env</code> file.
        Deleting a line removes that variable.
        {hasSecrets &&
          " Secret values are hidden — leave a secret's masked value unchanged to keep it."}
      </p>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={16}
        spellCheck={false}
        placeholder={"DATABASE_URL=postgres://...\nPORT=3000"}
        className="font-mono text-xs"
      />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <FieldLabel className="text-xs" info="Environments assigned to any variable you add here. Existing variables keep the environments they already have.">
            New variables apply to
          </FieldLabel>
          <div className="flex flex-wrap gap-4">
            {ALL_TARGETS.map((t) => (
              <label
                key={t}
                className="flex cursor-pointer items-center gap-2 text-sm capitalize"
              >
                <Checkbox
                  checked={targets.includes(t)}
                  onCheckedChange={() => toggleTarget(t)}
                />
                {t}
              </label>
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setText(initial);
              onDone();
            }}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button onClick={save} disabled={pending || !dirty || targets.length === 0}>
            {pending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}
