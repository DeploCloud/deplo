import { isDataHostPath, isTextFileContent } from "../../map/volume-discovery";
import type { SourceMount } from "../../model";
import type { CoolifyStorages } from "../client";

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

  for (const f of st?.file_storages ?? []) {
    const mountPath = f.mount_path?.trim();
    if (!mountPath) continue;
    const hostPath = f.fs_path?.trim() || null;
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
    if (f.is_directory) {
      if (!asBind())
        notes.push(
          `${mountPath} is a mounted DIRECTORY on {panel} and it named no path on the host, so nothing of it could be copied.`,
        );
      continue;
    }
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
      hostPath,
      filePath: mountPath.split("/").pop() || null,
      content: f.content,
      mountPath,
    });
  }

  return { mounts, notes };
}
