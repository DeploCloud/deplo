import type { VolumeMount } from "../../types/container";
import type { SourceMount } from "../model";

import { type Mapped, deploFilesPath } from "./source-platform";
import { composeMountPaths } from "./compose-read";
import { isDataHostPath, isTextFileContent } from "./volume-discovery";

export interface MappedMounts {
  /**
   * Config files that must exist in the stack's files dir, with the container path
   * Dokploy mounted each one at (empty for a compose stack's, whose YAML does the
   * binding itself).
   */
  files: { filePath: string; content: string; mountPath: string }[];
  /** Named volumes and host binds, for `setAppVolumes`. */
  volumes: Omit<VolumeMount, "id">[];
}

/** lowercase-kebab, which is what Deplo requires of a volume label. */
export function volumeLabel(raw: string, fallback: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return cleaned || fallback;
}

/**
 * The file's name in the app's files dir, taken from the only address a mount
 * with no `filePath` has: the path it is mounted at inside the container
 * ("/etc/nginx/nginx.conf" -> "nginx.conf").
 */
function fileNameFromMountPath(mountPath: string): string {
  const last = mountPath
    .split("/")
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .pop();
  return last ?? "";
}

/**
 * `base`, or the first `<stem>-<n>.<ext>` nobody has taken yet.
 */
function uniqueFilePath(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const slash = base.lastIndexOf("/") + 1;
  const dot = base.indexOf(".", slash + 1);
  const stem = dot < 0 ? base : base.slice(0, dot);
  const ext = dot < 0 ? "" : base.slice(dot);
  let name = base;
  for (let i = 2; ; i++) {
    name = `${stem}-${i}${ext}`;
    if (!used.has(name)) break;
  }
  used.add(name);
  return name;
}

/**
 * Dokploy's three mount kinds -> Deplo's writers.
 */
export function mapMounts(
  mounts: SourceMount[] | null | undefined,
  opts: { isCompose: boolean; compose?: string | null },
): Mapped<MappedMounts> {
  const notes: string[] = [];
  const files: MappedMounts["files"] = [];
  const volumes: Omit<VolumeMount, "id">[] = [];
  const used = new Set<string>();
  const usedFiles = new Set<string>();
  const composeMounts = new Set(
    opts.isCompose ? composeMountPaths(opts.compose) : [],
  );

  for (const m of mounts ?? []) {
    const mountPath = m.mountPath?.trim();
    // A stack binds the path its YAML names, and that YAML came across as it was
    // written. A config file beside it would leave the bind pointing at nothing,
    // so the file's own bytes travel with the data, the way a bind mount does.
    const stackBind =
      m.type === "file" &&
      opts.isCompose &&
      (m.hostPath ?? "").startsWith("/") &&
      isDataHostPath(m.hostPath!) &&
      deploFilesPath(m.hostPath!) == null;
    if (m.type === "file" && !stackBind) {
      // The machine's own clock, resolver and hosts file, which half the compose
      // files in the world bind read-only. A panel hands them over WITH their
      // content, and `/etc/localtime` is a binary TZif blob: written into a
      // config file it took the whole import down with an encoding error.
      if (mountPath && !isDataHostPath(mountPath)) continue;
      // A real file of the app's that simply is not text. Its bytes travel in the
      // data phase, which is what copies a bind mount.
      if (m.content != null && !isTextFileContent(m.content)) {
        notes.push(
          `${mountPath || m.filePath} is not a text file, so it does not come across as a config file - its bytes travel with the data.`,
        );
        continue;
      }
      // Deplo owns the whole files dir, so only the file's own name travels -
      // never Dokploy's `../files/` prefix and never an absolute path.
      const declared = (m.filePath ?? "")
        .trim()
        .replace(/^\.\/+/, "")
        .replace(/^\/+|\/+$/g, "");
      const wanted = declared || fileNameFromMountPath(mountPath ?? "");
      if (!wanted || wanted.split("/").includes("..")) {
        notes.push(
          "A file mount has no usable path on {panel} - not imported.",
        );
        continue;
      }
      const name = uniqueFilePath(wanted, usedFiles);
      if (name !== wanted)
        notes.push(
          `Two file mounts are both called ${wanted}, so one of them is ${name} in this app's Files.`,
        );
      files.push({
        filePath: name,
        content: m.content ?? "",
        mountPath: mountPath ?? "",
      });
      // Only an application needs the pairing: a compose stack already binds the
      // file in its own YAML, and a second mount for it would fight that one.
      if (!opts.isCompose && mountPath)
        volumes.push({
          type: "app",
          name: volumeLabel(name, "file"),
          projectPath: name,
          mountPath,
          readOnly: false,
        });
      continue;
    }
    if (!mountPath) {
      notes.push("A mount has no container path on {panel} - not imported.");
      continue;
    }
    if (m.type === "volume") {
      // The stack's own YAML already binds this path, so a Storage row for it
      // would be a volume the deploy never mounts - and the one the data copy
      // then filled, while the stack came up on the empty one beside it.
      if (opts.isCompose && composeMounts.has(mountPath.replace(/\/+$/, "")))
        continue;
      const base = volumeLabel(
        m.volumeAlias ?? m.volumeName ?? "",
        volumeLabel(mountPath, "data"),
      );
      let name = base;
      for (let i = 2; used.has(name); i++) name = `${base}-${i}`;
      used.add(name);
      volumes.push({ type: "named", name, mountPath, readOnly: false });
      continue;
    }
    // bind
    const hostPath = m.hostPath?.trim();
    if (!hostPath) {
      notes.push(
        `Bind mount at ${mountPath} has no host path on {panel} - not imported.`,
      );
      continue;
    }
    // The panel's OWN per-service files directory, which Deplo has its own place
    // for. A host row here would recreate {panel}'s data path on this machine -
    // and then win the data copy's pairing over the files dir the stack mounts.
    const inFilesDir = deploFilesPath(hostPath);
    if (inFilesDir != null) {
      // The stack's own YAML already carries the rewritten `./x`.
      if (opts.isCompose) continue;
      const projectPath = inFilesDir.replace(/^\.\/?/, "");
      if (!projectPath) {
        notes.push(
          `${mountPath} mounts the whole of this app's directory on {panel} - re-add what it needs under Storage.`,
        );
        continue;
      }
      volumes.push({
        type: "app",
        name: volumeLabel(mountPath, "files"),
        projectPath,
        mountPath,
        readOnly: false,
      });
      continue;
    }
    volumes.push({
      type: "host",
      name: volumeLabel(mountPath, "bind"),
      hostPath,
      mountPath,
      readOnly: false,
    });
  }

  return { value: { files, volumes }, notes };
}
