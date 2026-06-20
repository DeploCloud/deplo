"use client";

import * as React from "react";
import { HardDrive, Plus, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { hostVolumeName, shortId } from "@/lib/utils";
import type { VolumeMount } from "@/lib/types";

/**
 * Presentational editor for a single-container project's persistent volumes (the
 * renderCompose path). Fetch-free — the parent form owns the save.
 *
 * Two kinds per row, switched by the "Host path" toggle:
 *  - NAMED (default): a human name + an absolute in-container mount path. The
 *    host-side volume name is namespaced per project (deplo-<slug>-<name>); we
 *    preview it here, but the server is the only thing that derives/trusts it. A
 *    blank name is fine in a draft row — the server derives one on save.
 *  - HOST: an absolute HOST path bound into the container. Only privileged users
 *    (the `canMountHostVolumes` grant, or instance admins) may save one; the
 *    server rejects it otherwise — we don't hide the control here.
 */
export function VolumeFields({
  slug,
  volumes,
  onChange,
}: {
  slug: string;
  volumes: VolumeMount[];
  onChange: (next: VolumeMount[]) => void;
}) {
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
            const isHost = v.type === "host";
            const previewName = (v.name || "").trim();
            return (
              <div
                key={v.id}
                className="rounded-lg border border-border p-3 space-y-3"
              >
                <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
                  <div className="space-y-1.5">
                    <Label className="text-xs">
                      {isHost ? "Host path" : "Name"}
                    </Label>
                    <Input
                      value={isHost ? (v.hostPath ?? "") : v.name}
                      onChange={(e) =>
                        update(
                          v.id,
                          isHost
                            ? { hostPath: e.target.value }
                            : { name: e.target.value },
                        )
                      }
                      placeholder={isHost ? "/srv/data" : "data"}
                      className="font-mono text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Mount path (in container)</Label>
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
                        checked={isHost}
                        onCheckedChange={(c) =>
                          update(v.id, { type: c ? "host" : "named" })
                        }
                      />
                      Host path
                    </label>
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
