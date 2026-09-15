"use client";

import * as React from "react";
import {
  switchKind,
  volumeProblem,
  type VolumeKind,
} from "@/lib/apps/volume-model";
import { shortId } from "@/lib/utils";
import type { VolumeMount } from "@/lib/types/container";
import type { ComposeMount } from "@/lib/apps/compose-storage";
import { ComposeMountList } from "./compose-mount-list";
import { AddMenu, EmptyPicker } from "./kind-picker";
import { MountRow } from "./mount-row";

export function VolumeFields({
  slug,
  volumes,
  composeMounts = [],
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
  composeMounts?: ComposeMount[];
  composeServices?: string[];
  defaultComposeService?: string | null;
  // COSMETIC only - the authoritative gate is `requireMountHostVolumes()` inside `setAppVolumes`.
  canMountHostVolumes?: boolean;
  containerWorkdir?: string | null;
  revealProblems?: boolean;
  fileContent?: (mount: VolumeMount) => React.ReactNode;
  onChange: (next: VolumeMount[]) => void;
}) {
  const pickService =
    composeServices.length > 1 ||
    (composeServices.length > 0 &&
      volumes.some((v) => (v.service ?? "") !== ""));

  const [touched, setTouched] = React.useState<Set<string>>(new Set());
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
      { id, type: kind, name: "", mountPath: "", readOnly: false },
    ]);
    setExpandedId(id);
  }

  if (volumes.length === 0 && composeMounts.length === 0) {
    return (
      <EmptyPicker onAdd={add} canMountHostVolumes={canMountHostVolumes} />
    );
  }

  return (
    <div className="space-y-3">
      {composeMounts.length > 0 && <ComposeMountList mounts={composeMounts} />}
      {volumes.length > 0 && (
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
      )}
      <AddMenu onAdd={add} canMountHostVolumes={canMountHostVolumes} />
    </div>
  );
}
