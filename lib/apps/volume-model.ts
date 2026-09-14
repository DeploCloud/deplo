// https://deplo.build/docs/guides/data/persistent-storage

import { hostVolumeName } from "../utils";
import {
  MOUNT_PROPAGATIONS,
  type MountPropagation,
  type VolumeMount,
} from "../types/container";

// VolumeKind - the stored discriminant, never renamed.
export type VolumeKind = NonNullable<VolumeMount["type"]>;

// VOLUME_KIND_ORDER - safest and most common first, the privileged one last.
export const VOLUME_KIND_ORDER: VolumeKind[] = ["named", "app", "host"];

export interface VolumeKindMeta {
  kind: VolumeKind;
  label: string;
  summary: string;
  examples: string;
  tooltip: string;
  sourceLabel: string;
  sourcePlaceholder: string;
  sourceTooltip: string;
  needsPermission: boolean;
  chip: "secondary" | "outline" | "warning";
  targetLabel: string | null;
}

export const VOLUME_KINDS: Record<VolumeKind, VolumeKindMeta> = {
  named: {
    kind: "named",
    label: "Volume",
    summary: "Disk space Deplo creates and keeps for this app",
    examples: "Good for uploads, a database's files, or a cache.",
    tooltip:
      "Empty disk space Deplo creates and looks after. Your app writes into it and everything is still there after the next deploy. Best for uploads, database files or a cache.",
    sourceLabel: "Name",
    sourcePlaceholder: "uploads",
    sourceTooltip:
      "A short name for this disk, so you can recognise it later. Deplo derives one from the path if you leave it empty.",
    needsPermission: false,
    chip: "secondary",
    targetLabel: "Stored on the server as",
  },
  app: {
    kind: "app",
    label: "File",
    summary: "A file you write here, put inside the app",
    examples: "Good for a config file, like config.toml or nginx.conf.",
    tooltip:
      "Write the file's contents here and Deplo keeps it in this app's Files, then puts it inside the app. Edit it any time - the app picks it up on the next deploy. Best for config files.",
    sourceLabel: "Path in Files",
    sourcePlaceholder: "config.toml",
    sourceTooltip:
      "Where Deplo keeps the file under this app's Files, for example config.toml or conf/nginx.conf. Relative, never starting with a slash. Deplo creates it for you when it isn't there yet.",
    needsPermission: false,
    chip: "outline",
    targetLabel: null,
  },
  host: {
    kind: "host",
    label: "Bind",
    summary: "A folder that already exists on the server",
    examples:
      "Only when the data is already on that machine, or something outside Deplo uses it too.",
    tooltip:
      'Shares a folder from the server\'s own filesystem, outside Deplo and visible to everything else on that machine. Only for data that is already there. Saving one needs the "Bind server folders" permission.',
    sourceLabel: "Path on the server",
    sourcePlaceholder: "/srv/media",
    sourceTooltip:
      "An absolute path on the server that runs this app, for example /srv/media. It is not managed by Deplo and is shared with everything else on the machine.",
    needsPermission: true,
    chip: "warning",
    targetLabel: null,
  },
};

// switchKind - switch a row's kind, keeping each kind's own source value.
export function switchKind(v: VolumeMount, kind: VolumeKind): VolumeMount {
  if (kind === kindOf(v)) return v;
  return { ...v, type: kind };
}

// containerWorkdir - where a built app's code runs inside its container.
export function containerWorkdir(
  source: string,
  rootDirectory: string | null | undefined,
): string | null {
  if (source === "docker-image" || source === "compose") return null;
  const root = (rootDirectory || ".")
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "");
  return !root || root === "." ? "/app" : `/app/${root}`;
}

// kindOf - the kind of a row, defaulting the absent discriminant to "named".
export function kindOf(v: Pick<VolumeMount, "type">): VolumeKind {
  return v.type ?? "named";
}

export function metaOf(v: Pick<VolumeMount, "type">): VolumeKindMeta {
  return VOLUME_KINDS[kindOf(v)];
}

// RESERVED_MOUNT_PREFIXES - container paths the runtime owns; mounting over them breaks the container.
export const RESERVED_MOUNT_PREFIXES = [
  "/proc",
  "/sys",
  "/dev",
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/var/run",
];

// reservedMountPath - whether this kind of entry may not take mountPath, because the runtime owns it.
export function reservedMountPath(
  mountPath: string,
  kind: VolumeKind,
): boolean {
  return RESERVED_MOUNT_PREFIXES.some((r) =>
    kind === "app"
      ? mountPath === r
      : mountPath === r || mountPath.startsWith(r + "/"),
  );
}

// VOLUME_NAME_RE - Docker's name shape for a managed volume; also blocks YAML key injection.
export const VOLUME_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
export const VOLUME_NAME_MAX = 40;

// mountOptions - the ":"-suffixed options a mount line ends with.
export function mountOptions(m: {
  readOnly?: boolean | null;
  propagation?: MountPropagation | null;
}): string {
  const opts = [m.readOnly ? "ro" : "", m.propagation ?? ""].filter(Boolean);
  return opts.length ? `:${opts.join(",")}` : "";
}

// parseMountPropagation - the propagation named in a mount line's option list, if any.
export function parseMountPropagation(
  opts: string[],
): MountPropagation | undefined {
  return MOUNT_PROPAGATIONS.find((p) => opts.includes(p));
}

// normalizeFilesPath - trimmed, the optional "./" dropped, no trailing slash.
export function normalizeFilesPath(path: string | null | undefined): string {
  return (path ?? "")
    .trim()
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

function lastSegment(path: string): string {
  const segments = (path ?? "").trim().replace(/\/+$/, "").split("/");
  const last = segments[segments.length - 1] ?? "";
  return last === "." || last === ".." ? "" : last;
}

// filesPathFromMountPath - the file name a mount path ends in.
export function filesPathFromMountPath(mountPath: string): string {
  return lastSegment(mountPath);
}

// derivedMountPath - where a row lands inside the container when the user does not say.
export function derivedMountPath(
  v: VolumeMount,
  workdir: string | null | undefined,
): string {
  if (!workdir) return "";
  const kind = kindOf(v);
  const rel =
    kind === "app"
      ? normalizeFilesPath(v.projectPath)
      : kind === "host"
        ? lastSegment((v.hostPath ?? "").trim())
        : // As typed, NOT case-folded: container paths are case-sensitive.
          (v.name ?? "").trim();
  if (!rel) return "";
  return `${workdir.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`;
}

// effectiveMountPath - what the user typed, or else the derived path.
export function effectiveMountPath(
  v: VolumeMount,
  workdir?: string | null,
): string {
  return (
    (v.mountPath ?? "").trim().replace(/\/+$/, "") ||
    derivedMountPath(v, workdir)
  );
}

// deriveVolumeName - a docker-volume-safe name derived from a mount path when the name is blank.
export function deriveVolumeName(mountPath: string): string {
  const s = mountPath
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "data";
}

// VolumeProblem - which field of a row is wrong, and what to say about it.
export interface VolumeProblem {
  field: "source" | "mountPath";
  message: string;
}

export function volumeProblem(
  v: VolumeMount,
  workdir?: string | null,
): VolumeProblem | null {
  const kind = kindOf(v);

  if (kind === "host") {
    const hostPath = (v.hostPath ?? "").trim().replace(/\/+$/, "");
    if (!hostPath)
      return {
        field: "source",
        message: "Add the folder's path on the server",
      };
    if (!hostPath.startsWith("/") || hostPath.length < 2)
      return {
        field: "source",
        message:
          "The path on the server must start with a slash, like /srv/media",
      };
    if (/[\s:]/.test(hostPath))
      return {
        field: "source",
        message: 'The path on the server cannot contain spaces or ":"',
      };
    if (hostPath.split("/").includes(".."))
      return { field: "source", message: 'The path cannot contain ".."' };
  } else if (kind === "app") {
    const p = normalizeFilesPath(v.projectPath);
    if (!p)
      return {
        field: "source",
        message: "Add the file's path in this app's Files",
      };
    if (p.startsWith("/"))
      return {
        field: "source",
        message: "Use a path relative to this app's Files, like config.toml",
      };
    if (/[\s:]/.test(p))
      return {
        field: "source",
        message: 'The path cannot contain spaces or ":"',
      };
    if (p.split("/").includes(".."))
      return { field: "source", message: 'The path cannot contain ".."' };
  } else {
    const name = (v.name ?? "").trim().toLowerCase();
    if (name && !VOLUME_NAME_RE.test(name))
      return {
        field: "source",
        message:
          "Use lowercase letters, digits, - or _ , starting with a letter or digit",
      };
    if (name.length > VOLUME_NAME_MAX)
      return {
        field: "source",
        message: `Keep the name under ${VOLUME_NAME_MAX + 1} characters`,
      };
  }

  const mountPath = effectiveMountPath(v, workdir);
  if (!mountPath) {
    if (kind === "named" && workdir)
      return {
        field: "source",
        message: "Give this storage a name, like uploads",
      };
    return {
      field: "mountPath",
      message: "Add a path inside the app, like /data",
    };
  }
  if (!mountPath.startsWith("/") || mountPath.length < 2)
    return {
      field: "mountPath",
      message: "The path inside the app must start with a slash, like /data",
    };
  if (/[\s:]/.test(mountPath))
    return {
      field: "mountPath",
      message: 'The path inside the app cannot contain spaces or ":"',
    };
  if (mountPath.split("/").includes(".."))
    return { field: "mountPath", message: 'The path cannot contain ".."' };
  if (reservedMountPath(mountPath, kind))
    return {
      field: "mountPath",
      message: `${mountPath} belongs to the system and cannot be replaced`,
    };

  return null;
}

// volumeSetProblem - the problem the SET has: two mounts at one path, or two volumes sharing a name.
export function volumeSetProblem(
  volumes: VolumeMount[],
  workdir?: string | null,
): string | null {
  const paths = new Set<string>();
  const names = new Set<string>();
  for (const v of volumes) {
    const path = effectiveMountPath(v, workdir);
    if (path) {
      // JSON, not a joined string: no separator a service name or path could contain.
      const key = JSON.stringify([(v.service ?? "").trim(), path]);
      if (paths.has(key)) return `Two mounts share the path ${path}`;
      paths.add(key);
    }
    if (kindOf(v) === "named") {
      const name = (
        (v.name ?? "").trim() || deriveVolumeName(path)
      ).toLowerCase();
      if (name) {
        if (names.has(name)) return `Two volumes share the name ${name}`;
        names.add(name);
      }
    }
  }
  return null;
}

// namedVolumeTarget - the on-host name a Volume row will use; null for a File, a Bind, or a pathless Volume.
export function namedVolumeTarget(
  v: VolumeMount,
  slug: string,
  workdir?: string | null,
): string | null {
  if (kindOf(v) !== "named") return null;
  const path = effectiveMountPath(v, workdir);
  const name = (v.name ?? "").trim() || (path ? deriveVolumeName(path) : "");
  return name ? hostVolumeName(slug, name.toLowerCase()) : null;
}

// volumeReadout - one sentence stating what this row will do at deploy.
export function volumeReadout(
  v: VolumeMount,
  slug: string,
  workdir?: string | null,
): string {
  const kind = kindOf(v);
  const at = effectiveMountPath(v, workdir);
  const ro = v.readOnly ? " The app can read it but not change it." : "";
  if (kind === "host") {
    const from = (v.hostPath ?? "").trim();
    if (!from || !at)
      return "Shares a folder that already exists on the server.";
    const follows =
      v.propagation === "rslave"
        ? " Anything mounted inside it later shows up too."
        : v.propagation === "rshared"
          ? " Anything mounted inside it later shows up on both sides."
          : "";
    const stillWritable =
      v.propagation && v.readOnly
        ? " What arrives that way stays writable."
        : "";
    return `Shares the server's ${from} at ${at} inside the app.${ro}${follows}${stillWritable}`;
  }
  if (kind === "app") {
    const from = normalizeFilesPath(v.projectPath);
    if (!from || !at) return "Keeps a file you write here in this app's Files.";
    return `Keeps ${from} in this app's Files and puts it at ${at} inside the app.${ro}`;
  }
  if (!at) return "Deplo creates the disk once you give it a name or a path.";
  const name = ((v.name ?? "").trim() || deriveVolumeName(at)).toLowerCase();
  return `Keeps ${at} on a disk Deplo manages (${hostVolumeName(slug, name)}). It survives every deploy.${ro}`;
}
