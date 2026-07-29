"use client";

import * as React from "react";
import { HardDrive, Plus, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldLabel } from "@/components/ui/info-tip";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { hostVolumeName, shortId } from "@/lib/utils";
import type { VolumeMount } from "@/lib/types";

type VolumeType = NonNullable<VolumeMount["type"]>;

/**
 * Presentational editor for an app's persistent volumes. Fetch-free — the parent
 * form owns the save.
 *
 * `composeServices` is non-empty only for a compose stack; each row then also
 * picks the service the volume mounts into (blank ⇒ the stack's default service,
 * i.e. the one a domain routes to), because mounting one volume into every
 * service of a stack races on first-use seeding. A single-container app has one
 * service and no picker.
 *
 * Three kinds per row, picked from the "Type" selector:
 *  - NAMED (default): a human name + an absolute in-container mount path. The
 *    host-side volume name is namespaced per project (deplo-<slug>-<name>); we
 *    preview it here, but the server is the only thing that derives/trusts it. A
 *    blank name is fine in a draft row — the server derives one on save.
 *  - PROJECT FILE: a path RELATIVE to the app's isolated files dir
 *    (e.g. "config.toml" or "uploads"). Stays inside the sandbox — no grant
 *    needed. The same place the `./<x>` compose convention targets.
 *  - HOST: an absolute HOST path bound into the container. Only privileged users
 *    (the `canMountHostVolumes` grant, or instance admins) may save one; the
 *    server rejects it otherwise — we don't hide the control here.
 */
export function VolumeFields({
  slug,
  volumes,
  composeServices = [],
  defaultComposeService,
  onChange,
}: {
  slug: string;
  volumes: VolumeMount[];
  /** Compose services to choose from; empty ⇒ single-container (no picker). */
  composeServices?: string[];
  /** Which service a blank pick resolves to at deploy (shown as the placeholder). */
  defaultComposeService?: string | null;
  onChange: (next: VolumeMount[]) => void;
}) {
  // One service (or none) needs no choice — the mount can only go one place, so
  // the row stays as simple as a single-container app's. The second clause keeps
  // the picker reachable when a compose EDIT has since collapsed the stack to one
  // service: a row still naming the old one has to stay fixable here.
  const pickService =
    composeServices.length > 1 ||
    (composeServices.length > 0 && volumes.some((v) => (v.service ?? "") !== ""));
  function update(id: string, patch: Partial<VolumeMount>) {
    onChange(volumes.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  }
  function remove(id: string) {
    onChange(volumes.filter((v) => v.id !== id));
  }
  function add() {
    onChange([
      ...volumes,
      // Client-only draft id (never imports the server-only newId). The data
      // layer keeps it or re-mints a vol_ id on save.
      { id: `vol_${shortId()}`, name: "", mountPath: "", readOnly: false },
    ]);
  }

  return (
    <div className="space-y-3">
      {volumes.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-6 text-center">
          <HardDrive className="size-5 text-muted-foreground" />
          <p className="text-sm font-medium">No volumes yet</p>
          <p className="text-xs text-muted-foreground">
            Mount a persistent named volume to keep data across deploys.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {volumes.map((v) => {
            const type: VolumeType = v.type ?? "named";
            const isHost = type === "host";
            const isApp = type === "app";
            const previewName = (v.name || "").trim();
            const sourceLabel = isHost
              ? "Host path"
              : isApp
                ? "App path (in files dir)"
                : "Name";
            const sourceValue = isHost
              ? (v.hostPath ?? "")
              : isApp
                ? (v.projectPath ?? "")
                : v.name;
            const sourcePlaceholder = isHost
              ? "/srv/data"
              : isApp
                ? "config.toml"
                : "data";
            return (
              <div
                key={v.id}
                className="rounded-lg border border-border p-3 space-y-3"
              >
                <div
                  className={
                    pickService
                      ? "grid gap-3 sm:grid-cols-[auto_auto_1fr_1fr]"
                      : "grid gap-3 sm:grid-cols-[auto_1fr_1fr]"
                  }
                >
                  {pickService && (
                    <div className="space-y-1.5">
                      <FieldLabel
                        className="text-xs"
                        info="Which service of this compose stack the volume is mounted into. Only that service sees the data."
                      >
                        Service
                      </FieldLabel>
                      <Select
                        value={v.service ?? ""}
                        onValueChange={(s) => update(v.id, { service: s })}
                      >
                        <SelectTrigger className="text-sm">
                          <SelectValue
                            placeholder={
                              defaultComposeService
                                ? `${defaultComposeService} (default)`
                                : "Default service"
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {composeServices.map((s) => (
                            <SelectItem key={s} value={s}>
                              {s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <div className="space-y-1.5">
                    <FieldLabel
                      className="text-xs"
                      info="Named volume: persistent Docker volume. App file: a path in this app's files. Host path: absolute host path, needs host-volume permission"
                    >
                      Type
                    </FieldLabel>
                    <Select
                      value={type}
                      onValueChange={(t) =>
                        update(v.id, { type: t as VolumeType })
                      }
                    >
                      <SelectTrigger className="text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="named">Named volume</SelectItem>
                        {/* "app" — the domain-object discriminant. The wire
                            spelling ("service") is applied by the parent form on
                            save; using it here left the row rendering as a named
                            volume, which made the type unselectable. */}
                        <SelectItem value="app">App file</SelectItem>
                        <SelectItem value="host">Host path</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">{sourceLabel}</Label>
                    <Input
                      value={sourceValue}
                      onChange={(e) =>
                        update(
                          v.id,
                          isHost
                            ? { hostPath: e.target.value }
                            : isApp
                              ? { projectPath: e.target.value }
                              : { name: e.target.value },
                        )
                      }
                      placeholder={sourcePlaceholder}
                      className="font-mono text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <FieldLabel
                      className="text-xs"
                      info={
                        <>
                          Absolute path inside the container where the volume is
                          mounted, such as{" "}
                          <code className="font-mono">/data</code>.
                        </>
                      }
                    >
                      Mount path (in container)
                    </FieldLabel>
                    <Input
                      value={v.mountPath}
                      onChange={(e) =>
                        update(v.id, { mountPath: e.target.value })
                      }
                      placeholder="/data"
                      className="font-mono text-sm"
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <p className="truncate text-xs text-muted-foreground">
                    {isHost ? (
                      "Binds a path on the deploy host — needs the host-volume permission."
                    ) : isApp ? (
                      "Binds a path inside this app's isolated files directory."
                    ) : previewName ? (
                      <>
                        Host volume:{" "}
                        <code className="font-mono">
                          {hostVolumeName(slug, previewName)}
                        </code>
                      </>
                    ) : (
                      "Host volume name is derived from the mount path."
                    )}
                  </p>
                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Switch
                        checked={v.readOnly}
                        onCheckedChange={(c) => update(v.id, { readOnly: c })}
                      />
                      Read-only
                    </label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground"
                      onClick={() => remove(v.id)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Button type="button" variant="outline" size="sm" onClick={add}>
        <Plus className="size-4" />
        Add volume
      </Button>
    </div>
  );
}
