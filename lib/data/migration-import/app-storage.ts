import "server-only";

import { newId } from "../../ids";
import { canMountHostVolumes } from "../../membership";
import type { VolumeMount } from "../../types/container";
import { reservedMountPath } from "../../apps/volume-model";
import { composeFileBindings } from "../../deploy/compose-lint/volumes";
import type { ComposeRepoApp } from "../../migration/map/compose-read";
import { type MappedMounts, volumeLabel } from "../../migration/map/mounts";
import { composeVolumeMounts } from "../../migration/map/volume-discovery";
import type { createApp } from "../apps/create";
import { setAppVolumes } from "../apps/volumes";
import { writeAppFile } from "../app-files";

export async function landAppStorage(
  created: Awaited<ReturnType<typeof createApp>>,
  mounts: { value: MappedMounts },
  shape: {
    isCompose: boolean;
    compose: string | null;
    asRepoApp: ComposeRepoApp | null;
    yamlText: string;
  },
  notes: string[],
): Promise<void> {
  const { isCompose, compose, asRepoApp, yamlText } = shape;
  const unwritten = new Set<string>();
  for (const f of mounts.value.files) {
    try {
      try {
        await writeAppFile(created.id, f.filePath, f.content);
      } catch {
        await writeAppFile(created.id, f.filePath, f.content);
      }
    } catch (e) {
      unwritten.add(f.filePath);
      if (!isCompose)
        notes.push(
          `${f.filePath} could not be written into this app's Files: ${
            e instanceof Error ? e.message : "refused"
          }. {panel} still has it - copy it from there into Files, and mount it under Storage.`,
        );
    }
  }

  let volumes = mounts.value.volumes.filter(
    (v) => !(v.type === "app" && unwritten.has(v.projectPath ?? "")),
  );

  if (asRepoApp)
    for (const v of composeVolumeMounts(yamlText))
      volumes.push({
        type: "named",
        name: volumeLabel(v.name, "data"),
        mountPath: v.mountPath,
        readOnly: false,
      });

  if (isCompose && compose) {
    const bindings = composeFileBindings(compose);
    for (const f of mounts.value.files) {
      const bound = bindings.find((b) => b.filePath === f.filePath);
      if (!bound) continue;
      volumes.push({
        type: "app",
        name: volumeLabel(f.filePath, "file"),
        projectPath: f.filePath,
        mountPath: bound.mountPath,
        service: bound.service,
        readOnly: bound.readOnly,
      });
    }
  }
  if (
    volumes.some((v) => v.type === "host") &&
    !(await canMountHostVolumes())
  ) {
    notes.push(
      `You don't have permission to mount host folders, so ${volumes
        .filter((v) => v.type === "host")
        .map((v) => v.hostPath)
        .join(
          ", ",
        )} did not come across. An admin turns it on with "Bind server folders" in Settings → Users.`,
    );
    volumes = volumes.filter((v) => v.type !== "host");
  }
  const refusedMounts: string[] = [];
  volumes = volumes.filter((v) => {
    const path = (v.mountPath ?? "").trim().replace(/\/+$/, "");
    if (!path || !reservedMountPath(path, "app")) return true;
    refusedMounts.push(path);
    return false;
  });
  if (refusedMounts.length > 0)
    notes.push(
      `${refusedMounts.join(", ")} ${refusedMounts.length === 1 ? "is a path" : "are paths"} the container runtime owns, so ${refusedMounts.length === 1 ? "it" : "they"} did not come across. Everything else this app mounts did.`,
    );
  if (volumes.length > 0) {
    try {
      await setAppVolumes(
        created.id,
        volumes.map((v) => ({ ...v, id: newId("vol") }) as VolumeMount),
        { imported: true },
      );
    } catch (e) {
      notes.push(
        `Volumes were not imported: ${e instanceof Error ? e.message : "refused"}. Add them under Storage.`,
      );
    }
  }
}
