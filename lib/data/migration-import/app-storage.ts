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

// The app's config files and volumes, after the app exists: the files are written
// into its Files the same way the Storage editor writes them, and every mount that
// needs no grant survives one that does.
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
      // Retried once on purpose: it is a single call to a host that answered a
      // moment ago, and this content lives nowhere else on this side.
      try {
        await writeAppFile(created.id, f.filePath, f.content);
      } catch {
        await writeAppFile(created.id, f.filePath, f.content);
      }
    } catch (e) {
      unwritten.add(f.filePath);
      // Only worth saying for a single-image app: there, a file that was not
      // written is a file that is GONE, and its mount is dropped below with it.
      // The stack's own deploy will write the compose one on its own.
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

  // A compose service that came across as an APP keeps its storage: its volumes were
  // declared in the compose file, not in the panel's mounts, and without them the app
  // arrives with nowhere for the data cutover to put the bytes.
  if (asRepoApp)
    for (const v of composeVolumeMounts(yamlText))
      volumes.push({
        type: "named",
        name: volumeLabel(v.name, "data"),
        mountPath: v.mountPath,
        readOnly: false,
      });

  // A compose stack's config file is mounted by the stack's OWN yaml, so nothing in
  // Storage described it and the Storage page showed an empty list for an app that
  // demonstrably had files.
  if (isCompose && compose) {
    const bindings = composeFileBindings(compose);
    for (const f of mounts.value.files) {
      // Unlike a single-image app's File entry, this row does not depend on the
      // write above having landed: the file is in `app_mounts` too, and the
      // agent writes it from there on every bring-up.
      const bound = bindings.find((b) => b.filePath === f.filePath);
      if (!bound) continue; // in the files dir but mounted nowhere: nothing to show
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
  // A host bind needs the host-volumes grant, and setAppVolumes refuses the WHOLE
  // set over one of them - which used to drop the app's named volumes with it.
  // Leave the bind behind, keep the storage that needs no grant, and say so.
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
  // Same shape as the grant filter above, and for the same measured reason:
  // `setAppVolumes` writes the whole set or nothing, so ONE entry it will not take
  // used to leave the app with NO storage at all.
  const refusedMounts: string[] = [];
  volumes = volumes.filter((v) => {
    const path = (v.mountPath ?? "").trim().replace(/\/+$/, "");
    // The relaxed rule an import gets: reserved only AS the path itself.
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
