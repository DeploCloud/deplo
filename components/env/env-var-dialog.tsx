"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Plus,
  Trash2,
  Share2,
  ArrowUpRight,
  ClipboardPaste,
  Info,
  KeyRound,
  TriangleAlert,
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
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/empty-state";
import { FieldLabel } from "@/components/ui/info-tip";
import { gql, gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";
import { parseEnv } from "@/components/env/env-parse";
import { VIA_LABEL } from "@/components/env/env-filters";
import type { EnvVarDTO } from "@/lib/types";
import type { AppSharedVarDTO } from "@/lib/data/shared-vars";

/** Mirrors the server's key rule (lib/data/env.ts) so a bad key fails loudly here. */
const KEY_RE = /^[A-Z_][A-Z0-9_]*$/i;

/**
 * A shared var as the LINK rows read it: everything but the value. This dialog
 * only ever answers "does this variable reach the app?", so it neither renders a
 * value nor asks the API for one — an `AppSharedVarDTO` passed in from a page that
 * already has the values fits it unchanged.
 */
type LinkableSharedVar = Omit<AppSharedVarDTO, "value">;

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
  sharedVars?: LinkableSharedVar[];
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
  // Prefill: a plain var shows its value; a secret shows the MASK, which the
  // server keeps as-is (so editing only the secret flag can't blank the value).
  const [value, setValue] = React.useState(editing.value);
  const [secret, setSecret] = React.useState(editing.type === "secret");
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();

  function submit() {
    startTransition(async () => {
      // No `targets`: an App has no Environment of its own — it inherits exactly
      // one from its Project — so the server defaults every variable to all three.
      const res = await gqlAction<{ upsertEnv: { id: string } }>(
        `mutation($input: UpsertEnvInput!) { upsertEnv(input: $input) { id } }`,
        {
          input: {
            appId,
            key: editing.key,
            value,
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
            Update the value of this variable.
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
            {/* The key is disabled here, so the value is the first thing to put the
                caret in — and it keeps the Dialog's initial focus off the info
                button next to the Key label. */}
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

const ADD_TABS = ["standalone", "shared"] as const;
type AddTab = (typeof ADD_TABS)[number];

/**
 * Standalone + Shared, as two panels on ONE horizontal track that slides between
 * them when you switch tab — and the modal's height eases to whichever panel is
 * showing, so the slide glides instead of jumping. A fixed header (title + tabs),
 * a body that scrolls inside each panel, a footer pinned under it: paste a 40-line
 * `.env` and "Add 40" stays put while the rows scroll.
 *
 * Both panels stay mounted (a slide needs the outgoing one on screen too, moving
 * out as the other moves in), so the off-screen one is `inert` — neither tabbable
 * nor read by a screen reader while it waits in the wings. Each panel keeps its
 * NATURAL height (`self-start`); the viewport is clipped to the active one, which
 * is what its measured height drives.
 */
function AddDialog({
  open,
  onOpenChange,
  appId,
  sharedVars,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  appId: string;
  sharedVars?: LinkableSharedVar[];
}) {
  const [tab, setTab] = React.useState<AddTab>("standalone");
  const index = ADD_TABS.indexOf(tab);

  // The viewport's height follows the ACTIVE panel. We track BOTH panels' heights
  // live so a switch has the target height in hand (no measure-lag), and keep them
  // fresh as a panel grows or shrinks — a row added, the shared list loading in.
  // Measuring happens in the panel's own callback ref (fires the moment the node
  // attaches) rather than a layout effect: the panels mount inside Radix's Dialog
  // presence, so an effect can run a beat before their refs are wired.
  const panels = React.useRef<Record<AddTab, HTMLElement | null>>({
    standalone: null,
    shared: null,
  });
  const [heights, setHeights] = React.useState<Record<AddTab, number>>({
    standalone: 0,
    shared: 0,
  });
  const height = heights[tab] || undefined;

  // Created once (lazy state init, so `new ResizeObserver` never runs on the
  // server); a single instance keeps both panels measured.
  const [observer] = React.useState<ResizeObserver | null>(() =>
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver((entries) => {
          setHeights((prev) => {
            let next = prev;
            for (const entry of entries) {
              const el = entry.target as HTMLElement;
              const t = el.dataset.panel as AddTab | undefined;
              if (t && next[t] !== el.offsetHeight)
                next = { ...next, [t]: el.offsetHeight };
            }
            return next;
          });
        }),
  );
  React.useEffect(() => () => observer?.disconnect(), [observer]);

  // Measure on attach and observe for later size changes; unobserve on detach.
  const registerPanel = React.useCallback(
    (t: AddTab) => (el: HTMLElement | null) => {
      const prev = panels.current[t];
      if (prev) observer?.unobserve(prev);
      panels.current[t] = el;
      if (!el) return;
      const h = el.offsetHeight;
      setHeights((prevH) => (prevH[t] === h ? prevH : { ...prevH, [t]: h }));
      observer?.observe(el);
    },
    [observer],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="px-6 pb-4 pt-6">
          <DialogTitle>Add variables</DialogTitle>
          <DialogDescription>
            Add variables to this app, or link existing shared variables.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as AddTab)}
          className="flex min-h-0 flex-col"
        >
          {/* A segmented control on a track — the same shape the app wears
              elsewhere — so the idle half still reads as a place you can go. */}
          <div className="border-b border-border px-6 pb-4">
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
          </div>

          {/* The sliding viewport: its height eases to the active panel while the
              track glides one panel-width sideways per tab. */}
          <div
            className="relative overflow-hidden transition-[height] duration-300 ease-out motion-reduce:transition-none"
            style={{ height }}
          >
            <div
              className="flex transition-transform duration-300 ease-out motion-reduce:transition-none"
              style={{ transform: `translateX(-${index * 100}%)` }}
            >
              {ADD_TABS.map((t) => (
                <div
                  key={t}
                  ref={registerPanel(t)}
                  data-panel={t}
                  role="tabpanel"
                  aria-label={t === "standalone" ? "Standalone" : "Shared"}
                  inert={t !== tab ? true : undefined}
                  className="w-full shrink-0 self-start"
                >
                  {t === "standalone" ? (
                    <StandaloneTab
                      appId={appId}
                      onDone={() => onOpenChange(false)}
                    />
                  ) : (
                    <SharedTab
                      appId={appId}
                      sharedVars={sharedVars}
                      active={tab === "shared"}
                      onClose={() => onOpenChange(false)}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

type Row = { key: string; value: string };

/** The three columns every row of the key/value editor lines up on. */
const GRID = "grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_2rem] items-center gap-2";

/** Each panel's scrolling body caps here so its footer stays on screen and the
 *  whole modal stays inside its 85vh box — the chrome (header + tabs + footer) is
 *  ~14rem, so the body gets the rest. */
const PANEL_BODY_MAX = "max-h-[calc(85vh-14rem)]";

function StandaloneTab({ appId, onDone }: { appId: string; onDone: () => void }) {
  const [rows, setRows] = React.useState<Row[]>([{ key: "", value: "" }]);
  const [secret, setSecret] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();

  const filled = rows.filter((r) => r.key.trim() !== "");
  // The server silently SKIPS keys it can't parse (importEnv), so surface them
  // here instead — a pasted `export FOO=bar` would otherwise vanish without a word.
  const invalid = filled.filter((r) => !KEY_RE.test(r.key.trim()));

  function setRow(i: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function removeRow(i: number) {
    setRows((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev));
  }
  function addRow() {
    setRows((prev) => [...prev, { key: "", value: "" }]);
  }

  // Pasting `.env` content into a key field explodes into editable rows. A key can
  // never contain "=", so ANY paste that parses into at least one KEY=VALUE pair is
  // a .env paste — including the single most common case, one `KEY=value` line.
  // A paste with no "=" is just a key name and falls through to the normal paste.
  function onPaste(i: number, e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text");
    const parsed = parseEnv(text);
    if (parsed.length === 0) return;
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
      // No `targets` on either path: an App has no Environment of its own — it
      // inherits exactly one from its Project — so the server defaults every
      // variable to all three.
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
        `mutation($appId: String!, $blob: String!) {
          importEnv(appId: $appId, blob: $blob)
        }`,
        { appId, blob },
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
    <>
      {/* The body — the only thing that scrolls. */}
      <div className={cn("space-y-4 overflow-y-auto px-6 py-4", PANEL_BODY_MAX)}>
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <ClipboardPaste className="mt-px size-3.5 shrink-0" />
          <span>
            Enter one or more variables, or paste a full{" "}
            <code className="font-mono">.env</code> into a key field to fill the
            rows.
          </span>
        </p>

        {/* The rows are a small TABLE, not a stack of loose inputs: two labelled
            columns the eye can run down, and cells that carry no border of their
            own — the same shape the variables page shows them in afterwards. */}
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {/* Same px-2 as the rows, and the labels carry the cells' own px-1.5:
              the two grids then land on the very same tracks, so KEY sits over
              the keys and VALUE over the values, to the pixel. */}
          <div
            className={cn(
              GRID,
              "bg-secondary/40 px-2 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground",
            )}
          >
            <span className="px-1.5">Key</span>
            <span className="px-1.5">Value</span>
            <span aria-hidden />
          </div>

          {rows.map((r, i) => {
            const bad = r.key.trim() !== "" && !KEY_RE.test(r.key.trim());
            return (
              <div
                key={i}
                className={cn(GRID, "px-2 py-1.5", bad && "bg-destructive/5")}
              >
                <Input
                  value={r.key}
                  onChange={(e) => setRow(i, { key: e.target.value })}
                  onPaste={(e) => onPaste(i, e)}
                  placeholder="KEY"
                  aria-invalid={bad}
                  autoFocus={i === 0}
                  className={cn(
                    "h-8 border-0 bg-transparent px-1.5 font-mono text-xs shadow-none focus-visible:ring-1 focus-visible:ring-offset-0",
                    bad && "text-destructive focus-visible:ring-destructive",
                  )}
                />
                <Input
                  value={r.value}
                  onChange={(e) => setRow(i, { value: e.target.value })}
                  placeholder="value"
                  className="h-8 border-0 bg-transparent px-1.5 font-mono text-xs shadow-none focus-visible:ring-1 focus-visible:ring-offset-0"
                />
                {/* Kept in the layout, hidden while it would do nothing: the last
                    row can't be removed, and a column that comes and goes would
                    shift every input under the cursor. */}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={cn(
                    "text-muted-foreground hover:text-destructive",
                    rows.length === 1 && "invisible",
                  )}
                  onClick={() => removeRow(i)}
                  disabled={rows.length === 1}
                  aria-label="Remove row"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            );
          })}

          <div className="p-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={addRow}
              className="h-8 w-full justify-start px-2 text-muted-foreground hover:text-foreground"
            >
              <Plus className="size-4" />
              Add another
            </Button>
          </div>
        </div>

        {invalid.length > 0 && (
          <p className="flex items-start gap-2 text-xs text-destructive">
            <TriangleAlert className="mt-px size-3.5 shrink-0" />
            <span>
              {invalid.length === 1
                ? `“${invalid[0].key.trim()}” isn't a valid variable name.`
                : `${invalid.length} keys aren't valid variable names.`}{" "}
              Names must start with a letter or underscore and contain only
              letters, digits and underscores.
            </span>
          </p>
        )}

        {filled.length > 1 ? (
          <p className="flex items-start gap-2 rounded-lg border border-border bg-secondary/30 px-3 py-2.5 text-xs text-muted-foreground">
            <Info className="mt-px size-3.5 shrink-0" />
            <span>
              Pasted variables are added as plain — flip individual ones to secret
              from the table.
            </span>
          </p>
        ) : (
          <SecretRow secret={secret} onChange={setSecret} />
        )}
      </div>

      <DialogFooter className="border-t border-border px-6 py-4">
        <Button variant="outline" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button
          onClick={save}
          disabled={pending || filled.length === 0 || invalid.length > 0}
        >
          {pending ? "Saving…" : filled.length > 1 ? `Add ${filled.length}` : "Add"}
        </Button>
      </DialogFooter>
    </>
  );
}

function SharedTab({
  appId,
  sharedVars,
  active,
  onClose,
}: {
  appId: string;
  sharedVars?: LinkableSharedVar[];
  /** This tab is mounted even while off-screen (for the slide); only reach for
   *  the network once it has actually been opened. */
  active: boolean;
  onClose: () => void;
}) {
  const [vars, setVars] = React.useState<LinkableSharedVar[] | null>(
    sharedVars ?? null,
  );

  // Lazy-fetch when the caller didn't pass the in-scope set (aggregate view) —
  // but not before this tab is opened, so a dialog left on Standalone never
  // queries for shared vars it won't show.
  React.useEffect(() => {
    if (!active || vars !== null) return;
    let alive = true;
    gql<{ sharedVarsForApp: LinkableSharedVar[] }>(
      `query($appId: String!) {
        sharedVarsForApp(appId: $appId) {
          id key masked type targets via applied inherited linked
          updatedAt updatedBy { id name username avatarColor }
        }
      }`,
      { appId },
    )
      .then((d) => alive && setVars(d.sharedVarsForApp))
      .catch(() => alive && setVars([]));
    return () => {
      alive = false;
    };
  }, [appId, vars, active]);

  return (
    <>
      <div className={cn("overflow-y-auto px-6 py-4", PANEL_BODY_MAX)}>
        {vars === null ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            Loading…
          </p>
        ) : vars.length === 0 ? (
          <EmptyState
            icon={Share2}
            title="No shared variables"
            description="Create shared variables on the Variables page to reuse them across apps."
            className="py-10"
          />
        ) : (
          // Same table grammar as the Standalone tab: a labelled header, one row
          // per variable, no card floating loose inside a card.
          <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            <div className="flex items-center justify-between bg-secondary/40 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              <span>Shared variable</span>
              <span>Applied</span>
            </div>
            {vars.map((v) => (
              <SharedVarLinkRow key={v.id} appId={appId} sharedVar={v} />
            ))}
          </div>
        )}
      </div>

      {/* Each toggle already saved itself — Done just closes, it doesn't commit. */}
      <DialogFooter className="border-t border-border px-6 py-4 sm:justify-between">
        <Button variant="outline" asChild>
          <Link href="/variables?tab=shared">
            Create &amp; manage
            <ArrowUpRight className="size-4" />
          </Link>
        </Button>
        <Button onClick={onClose}>Done</Button>
      </DialogFooter>
    </>
  );
}

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
    <div className="flex items-center justify-between gap-3 px-3 py-2.5 transition-colors hover:bg-accent/30">
      <div className="min-w-0 space-y-1">
        <p className="truncate font-mono text-xs font-medium">{sharedVar.key}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {sharedVar.applied ? (
            <>
              <Badge variant="muted" className="gap-1 text-[10px] font-normal">
                <Share2 className="size-3" />
                {VIA_LABEL[sharedVar.via] ?? "Shared"}
              </Badge>
              {sharedVar.inherited && (
                <span className="text-[10px] text-muted-foreground">
                  Auto-applied — change it on the Variables page
                </span>
              )}
            </>
          ) : (
            <span className="text-[10px] text-muted-foreground">Not applied</span>
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

function SecretRow({
  secret,
  onChange,
}: {
  secret: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div>
          <p className="text-sm font-medium leading-none">Secret</p>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Hide the value in the UI after saving. It can never be read back.
          </p>
        </div>
      </div>
      <Switch checked={secret} onCheckedChange={onChange} aria-label="Secret" />
    </div>
  );
}
