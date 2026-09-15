import type { VolumeMount } from "../../types/container";
import type { SourceMount } from "../model";

import { type Mapped, deploFilesPath } from "./source-platform";
import { composeMountPaths } from "./compose-read";
import { isDataHostPath, isTextFileContent } from "./volume-discovery";

export interface MappedMounts {
  files: { filePath: string; content: string; mountPath: string }[];
  volumes: Omit<VolumeMount, "id">[];
}

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

function fileNameFromMountPath(mountPath: string): string {
  const last = mountPath
    .split("/")
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .pop();
  return last ?? "";
}

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
    const stackBind =
      m.type === "file" &&
      opts.isCompose &&
      (m.hostPath ?? "").startsWith("/") &&
      isDataHostPath(m.hostPath!) &&
      deploFilesPath(m.hostPath!) == null;
    if (m.type === "file" && !stackBind) {
      if (mountPath && !isDataHostPath(mountPath)) continue;
      if (m.content != null && !isTextFileContent(m.content)) {
        notes.push(
          `${mountPath || m.filePath} is not a text file, so it does not come across as a config file - its bytes travel with the data.`,
        );
        continue;
      }
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
    const hostPath = m.hostPath?.trim();
    if (!hostPath) {
      notes.push(
        `Bind mount at ${mountPath} has no host path on {panel} - not imported.`,
      );
      continue;
    }
    const inFilesDir = deploFilesPath(hostPath);
    if (inFilesDir != null) {
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
