"use client";

import * as React from "react";
import {
  ChevronDown,
  CornerDownRight,
  FileText,
  FolderSymlink,
  HardDrive,
  Plus,
  ShieldAlert,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { CopyButton } from "@/components/shared/copy-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  VOLUME_KINDS,
  VOLUME_KIND_ORDER,
  deriveVolumeName,
  derivedMountPath,
  effectiveMountPath,
  filesPathFromMountPath,
  kindOf,
  metaOf,
  namedVolumeTarget,
  normalizeFilesPath,
  switchKind,
  volumeProblem,
  volumeReadout,
  type VolumeKind,
} from "@/lib/apps/volume-model";
import { cn, shortId } from "@/lib/utils";
import type { MountPropagation, VolumeMount } from "@/lib/types";

/**
 * The Storage editor: a list of what this app keeps, one collapsed line each,
 * expanding into a form that asks one question — where should this data live?
 *
 * WHAT THIS REPLACED. A row of bare inputs under a `Type` dropdown reading
 * "Named volume / App file / Host path": three phrases that say nothing to
 * someone who has never run Docker (the owner's words: nobody knows what a named
 * volume is). The source column silently changed meaning with the type while
 * keeping the same look, the only account of what a row would DO was a truncated
 * grey line, and the first sign that a path was invalid was a toast after Save.
 *
 * The three kinds are now **Volume**, **File** and **Bind** — labels only, the
 * stored discriminants stay `named`/`app`/`host` — each an explained card with a
 * "good for" line, so picking one is recognition instead of vocabulary. Every
 * entry states in a sentence what it will do at deploy, a Volume also shows the
 * real on-host name it will use, and a bad field is ringed and explained as you
 * type by the SAME validator the save runs (`lib/apps/volume-model.ts`, whose
 * constants the server's `validateVolumes` imports).
 *
 * A **File** entry also carries the file's CONTENTS (`fileContent`, rendered by
 * `storage-file-editor.tsx`): you write the config file here instead of having
 * to go and create it in the Files tab first, which is what used to leave the
 * commonest File entry pointing at a path with nothing behind it. That box is
 * there from the moment the entry is added, not once the other fields are filled.
 *
 * Only the SOURCE of an entry is really required. "Path inside the app" fills
 * itself in for every app deplo builds (`derivedMountPath`) — leave it empty and
 * the storage lands in the app's own folder, greyed into the field so you see the
 * path before deciding whether you want a different one.
 *
 * Fetch-free — the parent form owns the reads and the save.
 */

const KIND_ICON: Record<VolumeKind, LucideIcon> = {
  named: HardDrive,
  app: FileText,
  host: FolderSymlink,
};

/**
 * The sentinel the Service dropdown uses for "let deplo pick" — the ABSENCE of a
 * choice, stored as `""`/absent. Radix forbids an empty item value, which is why
 * a row could never return to the default once a service had been picked. Same
 * pattern as `ENTRYPOINT_AUTO` in `components/domains/domain-config-fields.tsx`.
 */
const SERVICE_AUTO = "auto";

/** The same sentinel trick for "no propagation" — the stored value is absent,
 *  and Radix forbids an empty item value. */
const PROPAGATION_NONE = "none";

export function VolumeFields({
  slug,
  volumes,
  composeServices = [],
  defaultComposeService,
  canMountHostVolumes = true,
  containerWorkdir,
  revealProblems = false,
  fileContent,
  onChange,
}: {
  slug: string;
  volumes: VolumeMount[];
  /** Compose services to choose from; empty ⇒ single-container (no picker). */
  composeServices?: string[];
  /** Which service the Automatic option resolves to at deploy. */
  defaultComposeService?: string | null;
  /**
   * Whether the viewer holds the host-volume grant. COSMETIC only — the
   * authoritative gate is `requireMountHostVolumes()` inside `setAppVolumes`. A
   * Bind stays selectable either way: hiding it would hide why it is unavailable.
   */
  canMountHostVolumes?: boolean;
  /**
   * Where this app's code runs inside its container ("/app" for anything deplo
   * builds), so the hardest field can say what `./uploads` in the user's code is
   * called here. Null for a prebuilt image, whose working directory deplo cannot
   * know — the field then gets no invented example.
   */
  containerWorkdir?: string | null;
  /**
   * Show EVERY row's problem, touched or not. The parent flips this when a save
   * is blocked: otherwise the commonest mistake — add an entry, fill the source,
   * forget the path, press Save — produced a toast with no field ringed, which is
   * the exact "the toast is the first feedback" failure this editor set out to
   * fix.
   */
  revealProblems?: boolean;
  /**
   * The content editor for a **File** entry, rendered inside its expanded body.
   * The parent supplies it because the content is the real file on the app's
   * host — read and written over the agent, which this fetch-free editor does
   * not do. Absent ⇒ the entry asks for its two paths and nothing else.
   */
  fileContent?: (mount: VolumeMount) => React.ReactNode;
  onChange: (next: VolumeMount[]) => void;
}) {
  // One service (or none) needs no choice — the entry can only go one place, so
  // it stays as simple as a single-container app's. The second clause keeps the
  // picker reachable when a compose EDIT has since collapsed the stack to one
  // service: a row still naming the old one has to stay fixable here.
  const pickService =
    composeServices.length > 1 ||
    (composeServices.length > 0 &&
      volumes.some((v) => (v.service ?? "") !== ""));

  // Rows the user has actually edited. An entry added a second ago is not "wrong"
  // for being empty, so its problems stay silent until it is touched — it shows
  // what it WILL do instead.
  const [touched, setTouched] = React.useState<Set<string>>(new Set());
  // Single-expansion accordion. A lone entry opens on arrival (nothing to scan,
  // and it is almost certainly what you came to edit); several stay collapsed so
  // the page is a list you read rather than a wall of forms.
  const [expandedId, setExpandedId] = React.useState<string | null>(
    volumes.length === 1 ? volumes[0].id : null,
  );

  function update(id: string, patch: Partial<VolumeMount>) {
    setTouched((t) => (t.has(id) ? t : new Set(t).add(id)));
    onChange(volumes.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  }
  function changeKind(id: string, kind: VolumeKind) {
    onChange(volumes.map((v) => (v.id === id ? switchKind(v, kind) : v)));
  }
  function remove(id: string) {
    onChange(volumes.filter((v) => v.id !== id));
  }
  function add(kind: VolumeKind) {
    const id = `vol_${shortId()}`;
    onChange([
      ...volumes,
      // Client-only draft id (never imports the server-only newId). The data
      // layer keeps it or re-mints a vol_ id on save. `type` is always explicit
      // here; the `?? "named"` read fallback stays for legacy stored rows.
      { id, type: kind, name: "", mountPath: "", readOnly: false },
    ]);
    setExpandedId(id);
  }

  if (volumes.length === 0) {
    return (
      <EmptyPicker onAdd={add} canMountHostVolumes={canMountHostVolumes} />
    );
  }

  return (
    <div className="space-y-3">
      <ul className="space-y-2" aria-label="Storage this app keeps">
        {volumes.map((v) => {
          const problem =
            revealProblems || touched.has(v.id)
              ? volumeProblem(v, containerWorkdir)
              : null;
          return (
            <MountRow
              key={v.id}
              mount={v}
              slug={slug}
              problem={problem}
              // A problem force-expands its row: a blocked save must never
              // complain about a field it is keeping folded away.
              expanded={expandedId === v.id || problem !== null}
              onToggle={() =>
                setExpandedId((cur) => (cur === v.id ? null : v.id))
              }
              pickService={pickService}
              composeServices={composeServices}
              defaultComposeService={defaultComposeService}
              canMountHostVolumes={canMountHostVolumes}
              containerWorkdir={containerWorkdir}
              fileContent={fileContent}
              onChange={(patch) => update(v.id, patch)}
              onKindChange={(kind) => changeKind(v.id, kind)}
              onRemove={() => remove(v.id)}
            />
          );
        })}
      </ul>
      <AddMenu onAdd={add} canMountHostVolumes={canMountHostVolumes} />
    </div>
  );
}

/** `<source> → <path>`, the one line that identifies a collapsed entry. */
function IdentityLine({
  mount,
  containerWorkdir,
}: {
  mount: VolumeMount;
  containerWorkdir?: string | null;
}) {
  const kind = kindOf(mount);
  const meta = metaOf(mount);
  // The path it will really mount at, so a row that left the field empty reads
  // as what it does rather than as a blank.
  const path = effectiveMountPath(mount, containerWorkdir);
  const source =
    kind === "host"
      ? (mount.hostPath ?? "").trim()
      : kind === "app"
        ? (mount.projectPath ?? "").trim()
        : (mount.name ?? "").trim() || (path ? deriveVolumeName(path) : "");
  const shown = kind === "app" && source ? `Files/${source}` : source;
  const dim = "text-muted-foreground/60";
  return (
    <span className="min-w-0 truncate font-mono text-xs text-foreground">
      <span className={shown ? undefined : dim}>
        {shown || meta.sourcePlaceholder}
      </span>
      <span className="px-1.5 text-muted-foreground">→</span>
      <span className={path ? undefined : dim}>
        {path || (kind === "app" ? "/etc/nginx/nginx.conf" : "/data")}
      </span>
    </span>
  );
}

function MountRow({
  mount,
  slug,
  problem,
  expanded,
  onToggle,
  pickService,
  composeServices,
  defaultComposeService,
  canMountHostVolumes,
  containerWorkdir,
  fileContent,
  onChange,
  onKindChange,
  onRemove,
}: {
  mount: VolumeMount;
  slug: string;
  problem: { field: "source" | "mountPath"; message: string } | null;
  expanded: boolean;
  onToggle: () => void;
  pickService: boolean;
  composeServices: string[];
  defaultComposeService?: string | null;
  canMountHostVolumes: boolean;
  containerWorkdir?: string | null;
  fileContent?: (mount: VolumeMount) => React.ReactNode;
  onChange: (patch: Partial<VolumeMount>) => void;
  onKindChange: (kind: VolumeKind) => void;
  onRemove: () => void;
}) {
  const kind = kindOf(mount);
  const meta = metaOf(mount);
  const Icon = KIND_ICON[kind];
  const blockedBind = kind === "host" && !canMountHostVolumes;
  const readOnlyId = React.useId();

  // A File's path in Files follows the file name of the path inside the app
  // (/etc/nginx/nginx.conf ⇒ nginx.conf) until the user writes one of their own:
  // the same file, named once instead of twice. Only for a row that ARRIVED
  // empty — a saved entry's stored path is never rewritten by an edit to the
  // other field. "Did it start empty" is captured once (rows are keyed by id, so
  // this is per entry) rather than read from the current value, which would stop
  // deriving after the first character it wrote.
  const [sourceStartedEmpty] = React.useState(
    () => normalizeFilesPath(mount.projectPath) === "",
  );
  const [sourceEdited, setSourceEdited] = React.useState(false);
  const derivesSource = kind === "app" && sourceStartedEmpty && !sourceEdited;

  const sourceValue =
    kind === "host"
      ? (mount.hostPath ?? "")
      : kind === "app"
        ? (mount.projectPath ?? "")
        : mount.name;
  const setSource = (value: string) => {
    setSourceEdited(true);
    onChange(
      kind === "host"
        ? { hostPath: value }
        : kind === "app"
          ? { projectPath: value }
          : { name: value },
    );
  };

  const target = namedVolumeTarget(mount, slug, containerWorkdir);
  // What "Path inside the app" fills itself with when left empty — the whole
  // reason it is not a field you must answer.
  const derived = derivedMountPath(mount, containerWorkdir);

  return (
    <li className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 pr-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={`Edit this ${meta.label}`}
          className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
        >
          <Badge variant={meta.chip} className="shrink-0 gap-1.5">
            <Icon className="size-3" />
            {meta.label}
          </Badge>
          <IdentityLine mount={mount} containerWorkdir={containerWorkdir} />
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {mount.readOnly && <Badge variant="muted">Read-only</Badge>}
            {blockedBind && <Badge variant="warning">Needs permission</Badge>}
            <ChevronDown
              className={cn(
                "size-4 text-muted-foreground transition-transform",
                expanded && "rotate-180",
              )}
            />
          </span>
        </button>
        <SimpleTooltip
          content="Stop mounting this. The data itself is never deleted."
          side="left"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Remove this storage"
            className="shrink-0 text-muted-foreground"
            onClick={onRemove}
          >
            <Trash2 className="size-4" />
          </Button>
        </SimpleTooltip>
      </div>

      {expanded && (
        <>
          {/* Zone 1 — the one question this editor asks. */}
          <div className="space-y-2.5 border-t border-border p-4">
            <FieldLabel
              className="text-xs"
              info={
                <span className="space-y-1.5">
                  {VOLUME_KIND_ORDER.map((k) => (
                    <span key={k} className="block">
                      <strong className="font-medium">
                        {VOLUME_KINDS[k].label}
                      </strong>{" "}
                      {VOLUME_KINDS[k].tooltip}
                    </span>
                  ))}
                </span>
              }
            >
              Where should this data live?
            </FieldLabel>
            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup">
              {VOLUME_KIND_ORDER.map((k) => (
                <KindCard
                  key={k}
                  kind={k}
                  selected={k === kind}
                  canMountHostVolumes={canMountHostVolumes}
                  onSelect={() => onKindChange(k)}
                />
              ))}
            </div>
          </div>

          {/* Zone 2 — the blanks. */}
          <div className="grid gap-4 border-t border-border p-4 sm:grid-cols-2">
            {blockedBind && (
              <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning sm:col-span-2">
                <ShieldAlert className="mt-px size-3.5 shrink-0" />
                Your account can&apos;t save a Bind. An admin turns it on with
                &quot;Bind server folders&quot; in Settings → Users. Volume and
                File need no extra permission.
              </p>
            )}
            <Field
              label={meta.sourceLabel}
              // A Volume's name is optional once the path can supply one — the
              // mirror image of the path being optional once the name can. What
              // is never optional is BOTH: the row would then be nothing at all,
              // and the problem line says so.
              optional={kind === "named" && mount.mountPath.trim() !== ""}
              info={meta.sourceTooltip}
              value={sourceValue}
              onChange={setSource}
              placeholder={meta.sourcePlaceholder}
              prefix={kind === "app" ? "Files /" : undefined}
              invalid={problem?.field === "source"}
            />
            <Field
              label="Path inside the app"
              // Optional exactly when deplo has something to derive it from —
              // never a promise it can't keep. See `derivedMountPath`.
              optional={derived !== ""}
              info={
                containerWorkdir
                  ? kind === "app"
                    ? `Where the file appears inside the app. Leave it empty and deplo puts it in ${containerWorkdir}, the folder your code runs in — so a file your code opens as ./config.toml needs nothing here. Fill it in when the app wants it elsewhere, like /etc/nginx/nginx.conf.`
                    : `Where the app finds this storage. Leave it empty and deplo puts it in ${containerWorkdir}, the folder your code runs in — so a folder your code writes to as ./uploads needs nothing here. Fill it in when the app keeps its data elsewhere, like /var/lib/postgresql/data.`
                  : kind === "app"
                    ? "Where the file appears inside the app, file name included, like /etc/nginx/nginx.conf. deplo can't fill this in for a prebuilt image — the image chose its own working directory — so use the path the app's documentation asks for."
                    : "Where the app finds this storage, as an absolute path like /data. deplo can't fill this in for a prebuilt image — the image chose its own working directory — so use the path its documentation gives for the data you want to keep."
              }
              value={mount.mountPath}
              onChange={(value) =>
                onChange(
                  derivesSource
                    ? {
                        mountPath: value,
                        projectPath: filesPathFromMountPath(value),
                      }
                    : { mountPath: value },
                )
              }
              // The derived path IS the placeholder: what you would get by
              // typing nothing, shown before you decide whether to.
              placeholder={
                derived ||
                (kind === "app"
                  ? containerWorkdir
                    ? `${containerWorkdir}/config.toml`
                    : "/etc/nginx/nginx.conf"
                  : containerWorkdir
                    ? `${containerWorkdir}/uploads`
                    : "/data")
              }
              invalid={problem?.field === "mountPath"}
            />

            {kind === "app" && fileContent?.(mount)}

            {pickService && (
              <div className="space-y-1.5 sm:col-span-2">
                <FieldLabel
                  className="text-xs"
                  info="This app runs several services from its compose file. Only the service you pick can see this data — the other services are untouched."
                >
                  Which service uses this data?
                </FieldLabel>
                <Select
                  value={(mount.service ?? "") || SERVICE_AUTO}
                  onValueChange={(s) =>
                    onChange({ service: s === SERVICE_AUTO ? "" : s })
                  }
                >
                  <SelectTrigger className="text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={SERVICE_AUTO}>
                      {defaultComposeService
                        ? `Automatic — ${defaultComposeService}`
                        : "Automatic — the main service"}
                    </SelectItem>
                    {composeServices.map((s) => (
                      <SelectItem key={s} value={s} className="font-mono">
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Bind only, and the one control here that is pure Docker
                underneath: a folder on the server can have OTHER things mounted
                inside it (a network disk, a FUSE share, a volume another app
                puts there), and by default the app sees a snapshot taken when it
                started. Nothing on this screen said so, and the failure is
                silent — the folder simply looks empty. Named volumes and Files
                have no submounts, so they never ask. */}
            {kind === "host" && (
              <div className="space-y-1.5 sm:col-span-2">
                <FieldLabel
                  className="text-xs"
                  info="Another app, or the server itself, can mount a network disk or a shared folder inside this one. By default this app keeps seeing what was there the moment it started, and never notices the rest."
                >
                  What if something is mounted inside this folder?
                </FieldLabel>
                <Select
                  value={mount.propagation ?? PROPAGATION_NONE}
                  onValueChange={(p) =>
                    onChange({
                      propagation:
                        p === PROPAGATION_NONE
                          ? undefined
                          : (p as MountPropagation),
                    })
                  }
                >
                  <SelectTrigger className="text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* Each option names the docker keyword it writes. The
                        phrase is what a non-expert picks by; the token in
                        parentheses is what someone who already knows mount
                        propagation (or is reading a forum answer that says
                        "use rslave") searches the screen for. */}
                    <SelectItem value={PROPAGATION_NONE}>
                      Only what is already there (rprivate)
                    </SelectItem>
                    <SelectItem value="rslave">
                      Keep up with the server (rslave)
                    </SelectItem>
                    <SelectItem value="rshared">
                      Keep up, and let the server see this app&apos;s own
                      (rshared)
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 sm:col-span-2">
              <FieldLabel
                htmlFor={readOnlyId}
                className="cursor-pointer text-xs font-normal"
                info="The app can read this data but never write to it. Handy for a config file you want to stay exactly as you wrote it."
              >
                Let the app read but not change it (ro)
              </FieldLabel>
              <Switch
                id={readOnlyId}
                checked={mount.readOnly}
                onCheckedChange={(c) => onChange({ readOnly: c })}
              />
            </div>
          </div>

          {/* Zone 3 — what it will do, or the one thing wrong with it. */}
          <div className="space-y-1.5 border-t border-border bg-muted/30 px-4 py-2.5">
            {problem ? (
              <p className="flex items-start gap-2 text-xs text-destructive">
                <TriangleAlert className="mt-px size-3.5 shrink-0" />
                {problem.message}
              </p>
            ) : (
              <>
                <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <CornerDownRight className="mt-px size-3.5 shrink-0" />
                  {volumeReadout(mount, slug, containerWorkdir)}
                </p>
                {meta.targetLabel && target && (
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-[1.125rem] text-xs text-muted-foreground">
                    {meta.targetLabel}
                    <code className="min-w-0 rounded bg-background px-1.5 py-0.5 font-mono break-all text-foreground">
                      {target}
                    </code>
                    <CopyButton value={target} />
                    {!mount.name.trim() && (
                      <span>(name taken from the path)</span>
                    )}
                    <InfoTip content="The name deplo gives this storage on the server. It belongs to this app alone, so nothing else can read it or overwrite it. It is included in this app's backups." />
                  </p>
                )}
              </>
            )}
          </div>
        </>
      )}
    </li>
  );
}

/** One of the three answers to "where should this data live?". */
function KindCard({
  kind,
  selected,
  canMountHostVolumes,
  onSelect,
}: {
  kind: VolumeKind;
  selected: boolean;
  canMountHostVolumes: boolean;
  onSelect: () => void;
}) {
  const meta = VOLUME_KINDS[kind];
  const Icon = KIND_ICON[kind];
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex h-full items-start gap-2.5 rounded-lg border p-3 text-left transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none",
        selected
          ? "border-primary bg-primary/[0.06] ring-1 ring-primary/60"
          : "border-border hover:border-foreground/20 hover:bg-muted/40",
      )}
    >
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md border",
          selected
            ? "border-primary/40 bg-background text-primary"
            : "border-border bg-muted/50 text-muted-foreground",
        )}
      >
        <Icon className="size-3.5" />
      </span>
      <span className="min-w-0 space-y-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium">{meta.label}</span>
          {kind === "named" && <Badge variant="secondary">Most apps</Badge>}
          {kind === "host" && (
            <Badge variant={canMountHostVolumes ? "muted" : "warning"}>
              {canMountHostVolumes ? "Advanced" : "Needs permission"}
            </Badge>
          )}
        </span>
        <span className="block text-xs text-muted-foreground">
          {meta.examples}
        </span>
      </span>
    </button>
  );
}

/** A labelled input whose help lives in the label's tooltip, never below it. */
function Field({
  label,
  optional,
  info,
  value,
  onChange,
  placeholder,
  prefix,
  invalid,
}: {
  label: string;
  optional?: boolean;
  info: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Rendered inside the input's left edge, so a relative path reads as one. */
  prefix?: string;
  invalid?: boolean;
}) {
  // Associate the label with its input so clicking the label focuses the field
  // (and a screen reader announces the pair).
  const id = React.useId();
  return (
    <div className="space-y-1.5">
      <FieldLabel className="text-xs" htmlFor={id} info={info}>
        {label}
        {optional && (
          <span className="text-xs font-normal text-muted-foreground">
            (optional)
          </span>
        )}
      </FieldLabel>
      <div className="relative">
        {prefix && (
          <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-xs font-medium text-muted-foreground">
            {prefix}
          </span>
        )}
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-invalid={invalid || undefined}
          className={cn(
            "font-mono text-sm",
            prefix && "pl-14",
            invalid && "border-destructive focus-visible:ring-destructive/40",
          )}
        />
      </div>
    </div>
  );
}

/**
 * The first add is the one place worth spending room on: the kinds say what they
 * are FOR, so the choice is informed instead of a dropdown of jargon. Clicking
 * one creates an entry of that kind, already set.
 */
function EmptyPicker({
  onAdd,
  canMountHostVolumes,
}: {
  onAdd: (kind: VolumeKind) => void;
  canMountHostVolumes: boolean;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border p-6">
      <div className="mb-5 flex flex-col items-center gap-2 text-center">
        <span className="flex size-10 items-center justify-center rounded-lg border border-border bg-secondary">
          <HardDrive className="size-5 text-muted-foreground" />
        </span>
        <p className="text-sm font-medium">No storage yet</p>
        <p className="max-w-md text-xs text-muted-foreground">
          Everything this app writes is thrown away when it redeploys, unless
          you keep it here. Pick where the data should live:
        </p>
      </div>
      {/* Volume and File are the two a normal app wants; they get the room. Bind
          is host-coupled and permission-gated — expert surface, so it sits below
          as one quiet row rather than a third equal default on the first screen a
          new user sees (AGENTS.md: expert features stay off the first-run path).
          One click away either way, never hidden, never disabled. */}
      <div className="grid gap-2 sm:grid-cols-2">
        {(["named", "app"] as VolumeKind[]).map((kind) => {
          const meta = VOLUME_KINDS[kind];
          const Icon = KIND_ICON[kind];
          return (
            <button
              key={kind}
              type="button"
              onClick={() => onAdd(kind)}
              className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-primary/40 hover:bg-muted/40"
            >
              <span className="flex items-center gap-2">
                <Icon className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">{meta.label}</span>
                {kind === "named" && (
                  <Badge variant="secondary" className="ml-auto">
                    Most apps
                  </Badge>
                )}
              </span>
              <span className="text-xs text-muted-foreground">
                {meta.summary}
              </span>
              <span className="text-xs text-muted-foreground/70">
                {meta.examples}
              </span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        onClick={() => onAdd("host")}
        className="mt-2 flex w-full items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-left transition-colors hover:bg-muted/40"
      >
        <FolderSymlink className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium">{VOLUME_KINDS.host.label}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {VOLUME_KINDS.host.summary}
        </span>
        <Badge variant="muted" className="shrink-0">
          {canMountHostVolumes ? "Advanced" : "Needs permission"}
        </Badge>
      </button>
    </div>
  );
}

/** Adding another entry: the same three explained options, in a menu. */
function AddMenu({
  onAdd,
  canMountHostVolumes,
}: {
  onAdd: (kind: VolumeKind) => void;
  canMountHostVolumes: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Plus className="size-4" />
          Add storage
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        {VOLUME_KIND_ORDER.map((kind) => {
          const meta = VOLUME_KINDS[kind];
          const Icon = KIND_ICON[kind];
          return (
            <DropdownMenuItem
              key={kind}
              onSelect={() => onAdd(kind)}
              className="items-start gap-2.5"
            >
              <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 space-y-0.5">
                <span className="flex items-center gap-2 text-sm font-medium">
                  {meta.label}
                  {meta.needsPermission && !canMountHostVolumes && (
                    <Badge variant="warning">Permission</Badge>
                  )}
                </span>
                <span className="block text-xs whitespace-normal text-muted-foreground">
                  {meta.summary}
                </span>
                <span className="block text-xs whitespace-normal text-muted-foreground/70">
                  {meta.examples}
                </span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
