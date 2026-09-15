"use client";

import * as React from "react";
import {
  ChevronDown,
  CornerDownRight,
  ShieldAlert,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { CopyButton } from "@/components/shared/copy-button";
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
  volumeReadout,
  type VolumeKind,
} from "@/lib/apps/volume-model";
import { Collapse } from "@/components/shared/collapse";
import { cn } from "@/lib/utils";
import type { MountPropagation, VolumeMount } from "@/lib/types/container";
import { DocsLink } from "@/components/ui/docs-link";
import { KIND_ICON, KindCard } from "./kind-picker";
import { Field } from "./field";

// Radix forbids an empty item value, so "stored as absent" needs a sentinel of its own.
const SERVICE_AUTO = "auto";

const PROPAGATION_NONE = "none";

export function IdentityLine({
  mount,
  containerWorkdir,
}: {
  mount: VolumeMount;
  containerWorkdir?: string | null;
}) {
  const kind = kindOf(mount);
  const meta = metaOf(mount);
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

export function MountRow({
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
  const derived = derivedMountPath(mount, containerWorkdir);

  return (
    <li className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 pr-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={`Edit this ${meta.label}`}
          className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
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

      <Collapse open={expanded}>
        <>
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
              docs="storage.overview"
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

          <div className="grid gap-4 border-t border-border p-4 sm:grid-cols-2">
            {blockedBind && (
              <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-wash-strong px-3 py-2 text-xs text-warning sm:col-span-2">
                <ShieldAlert className="mt-px size-3.5 shrink-0" />
                Your account can&apos;t save a Bind. An admin turns it on with
                &quot;Bind server folders&quot; in Settings → Users. Volume and
                File need no extra permission.{" "}
                <DocsLink topic="hostAccess.grant" />
              </p>
            )}
            <Field
              label={meta.sourceLabel}
              optional={kind === "named" && mount.mountPath.trim() !== ""}
              info={meta.sourceTooltip}
              docs="storage.source"
              value={sourceValue}
              onChange={setSource}
              placeholder={meta.sourcePlaceholder}
              prefix={kind === "app" ? "Files /" : undefined}
              invalid={problem?.field === "source"}
            />
            <Field
              label="Path inside the app"
              optional={derived !== ""}
              info={
                containerWorkdir
                  ? kind === "app"
                    ? `Where the file appears inside the app. Empty puts it in ${containerWorkdir}, the folder your code runs in.`
                    : `Where the app finds this storage. Empty puts it in ${containerWorkdir}, the folder your code runs in.`
                  : kind === "app"
                    ? "Where the file appears inside the app, file name included, like /etc/nginx/nginx.conf."
                    : "Where the app finds this storage, as an absolute path like /data."
              }
              docs="storage.mountPath"
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
                  info="This app runs several services from its compose file. Only the service you pick can see this data - the other services are untouched."
                  docs="storage.container"
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
                        ? `Automatic - ${defaultComposeService}`
                        : "Automatic - the main service"}
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

            {kind === "host" && (
              <div className="space-y-1.5 sm:col-span-2">
                <FieldLabel
                  className="text-xs"
                  info="When something else mounts a disk or a folder inside this one, this app never notices it by default."
                  docs="storage.bindOptions"
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
                docs="storage.bindOptions"
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

          <div className="space-y-1.5 border-t border-border bg-surface px-4 py-2.5">
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
                    <InfoTip
                      content="The name Deplo gives this storage on the server. It belongs to this app alone, and rides its backups."
                      docs="storage.source"
                    />
                  </p>
                )}
              </>
            )}
          </div>
        </>
      </Collapse>
    </li>
  );
}
