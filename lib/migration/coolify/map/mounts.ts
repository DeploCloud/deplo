import { isDataHostPath, isTextFileContent } from "../../map/volume-discovery";
import type { SourceMount } from "../../model";
import type { CoolifyStorages } from "../client";

/**
 * Coolify names a volume `<resource uuid>-<what you called it>`. The uuid is its
 * own bookkeeping, and it would otherwise be the name in Storage here forever.
 */
function withoutResourceUuid(
  name: string | undefined,
  uuid: string | undefined,
): string | null {
  if (!name || !uuid) return null;
  const head = name.slice(0, uuid.length);
  const sep = name[uuid.length];
  if (head !== uuid || (sep !== "-" && sep !== "_")) return null;
  return name.slice(uuid.length + 1) || null;
}

/**
 * `GET /{kind}/{uuid}/storages` -> the mounts the shared mapper reads. A row with
 * a `host_path` is a bind mount; without one, `name` is already the volume's real
 * name on the host.
 */
export function coolifyMounts(
  st: CoolifyStorages | null | undefined,
  resourceUuid?: string,
): {
  mounts: SourceMount[];
  notes: string[];
} {
  const mounts: SourceMount[] = [];
  const notes: string[] = [];
  let n = 0;

  for (const s of st?.persistent_storages ?? []) {
    const mountPath = s.mount_path?.trim();
    if (!mountPath) continue;
    const hostPath = s.host_path?.trim();
    mounts.push(
      hostPath
        ? {
            mountId: s.uuid ?? `cool-mnt-${n++}`,
            type: "bind",
            hostPath,
            mountPath,
          }
        : {
            mountId: s.uuid ?? `cool-mnt-${n++}`,
            type: "volume",
            volumeName: s.name?.trim() || null,
            volumeAlias: withoutResourceUuid(s.name?.trim(), resourceUuid),
            mountPath,
          },
    );
  }

  // {panel} files EVERY bind mount here, a config file and a whole data directory
  // alike: the config file travels as content, everything else as a bind the data
  // phase copies.
  for (const f of st?.file_storages ?? []) {
    const mountPath = f.mount_path?.trim();
    if (!mountPath) continue;
    const hostPath = f.fs_path?.trim() || null;
    // The machine's own clock, resolver and hosts file. Neither channel: the
    // target has its own, and `/etc/localtime` is a binary blob that took the
    // whole import down when it was written into a config file.
    if (!isDataHostPath(hostPath ?? mountPath)) continue;
    const asBind = () => {
      if (hostPath) {
        mounts.push({
          mountId: f.uuid ?? `cool-file-${n++}`,
          type: "bind",
          hostPath,
          mountPath,
        });
        return true;
      }
      return false;
    };
    // A directory is not a config file, and it used to be dropped by BOTH
    // channels - {panel} names no bind for it either, so a whole data directory
    // arrived empty with one note to show for it.
    if (f.is_directory) {
      if (!asBind())
        notes.push(
          `${mountPath} is a mounted DIRECTORY on {panel} and it named no path on the host, so nothing of it could be copied.`,
        );
      continue;
    }
    // Content missing or not text: a config file cannot hold it (Postgres refuses
    // a NUL), but the data phase copies the file itself.
    if (typeof f.content !== "string" || !isTextFileContent(f.content)) {
      if (!asBind())
        notes.push(
          `The file mounted at ${mountPath} did not come with its contents - re-add it under Storage.`,
        );
      continue;
    }
    mounts.push({
      mountId: f.uuid ?? `cool-file-${n++}`,
      type: "file",
      // Where it really is on the host. A stack binds that path verbatim, so the
      // config channel would leave the compose pointing at a path nothing filled.
      hostPath,
      filePath: mountPath.split("/").pop() || null,
      content: f.content,
      mountPath,
    });
  }

  return { mounts, notes };
}
