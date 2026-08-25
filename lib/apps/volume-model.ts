// https://deplo.build/docs/guides/data/persistent-storage

import { hostVolumeName } from "../utils";
import {
  MOUNT_PROPAGATIONS,
  type MountPropagation,
  type VolumeMount,
} from "../types";

/**
 * The pure model behind the Storage settings editor: what the three kinds of mount
 * ARE in the UI's words, and the one validator both the editor's inline lint and
 * the save-time check run.
 */

/** The stored discriminant. NEVER renamed — see the module note. */
export type VolumeKind = NonNullable<VolumeMount["type"]>;

/** UI order: safest and most common first, the privileged one last. */
export const VOLUME_KIND_ORDER: VolumeKind[] = ["named", "app", "host"];

export interface VolumeKindMeta {
  kind: VolumeKind;
  /** What the UI calls it. */
  label: string;
  /** One line, in consequences rather than Docker nouns. Shown in the picker. */
  summary: string;
  /**
   * "Good for …" — the recognition line. Picking a kind is otherwise a question
   * a non-expert cannot answer ("do I want a volume or a bind?"); naming the
   * situations turns it into one they can ("I have uploads to keep").
   */
  examples: string;
  /** The tooltip on the kind control — the "when would I pick this" answer. */
  tooltip: string;
  /** Label of the single source field this kind needs. */
  sourceLabel: string;
  sourcePlaceholder: string;
  /** Tooltip for the source field. */
  sourceTooltip: string;
  /** True when saving one needs the `canMountHostVolumes` grant. */
  needsPermission: boolean;
  /** Badge tone for the collapsed row's identity chip and the picker cards. */
  chip: "secondary" | "outline" | "warning";
  /**
   * Volume only: what the derived on-host name row is called.
   */
  targetLabel: string | null;
}

export const VOLUME_KINDS: Record<VolumeKind, VolumeKindMeta> = {
  named: {
    kind: "named",
    label: "Volume",
    summary: "Disk space deplo creates and keeps for this app",
    examples: "Good for uploads, a database's files, or a cache.",
    tooltip:
      "Empty disk space deplo creates and looks after. Your app writes into it and everything is still there after the next deploy. Best for uploads, database files or a cache.",
    sourceLabel: "Name",
    sourcePlaceholder: "uploads",
    sourceTooltip:
      "A short name for this disk, so you can recognise it later. deplo derives one from the path if you leave it empty.",
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
      "Write the file's contents here and deplo keeps it in this app's Files, then puts it inside the app. Edit it any time — the app picks it up on the next deploy. Best for config files.",
    sourceLabel: "Path in Files",
    sourcePlaceholder: "config.toml",
    sourceTooltip:
      "Where deplo keeps the file under this app's Files, for example config.toml or conf/nginx.conf. Relative, never starting with a slash. deplo creates it for you when it isn't there yet.",
    needsPermission: false,
    chip: "outline",
    targetLabel: null,
  },
  host: {
    kind: "host",
    label: "Bind",
    summary: "A folder that already exists on the server",
    examples:
      "Only when the data is already on that machine, or something outside deplo uses it too.",
    tooltip:
      'Shares a folder from the server\'s own filesystem, outside deplo and visible to everything else on that machine. Only for data that is already there. Saving one needs the "Bind server folders" permission.',
    sourceLabel: "Path on the server",
    sourcePlaceholder: "/srv/media",
    sourceTooltip:
      "An absolute path on the server that runs this app, for example /srv/media. It is not managed by deplo and is shared with everything else on the machine.",
    needsPermission: true,
    chip: "warning",
    targetLabel: null,
  },
};

/**
 * Switch a row's kind, KEEPING each kind's own source value. The no-op guard is
 * load-bearing, not a micro-optimisation.
 */
export function switchKind(v: VolumeMount, kind: VolumeKind): VolumeMount {
  if (kind === kindOf(v)) return v;
  return { ...v, type: kind };
}

/**
 * Where a BUILT app's code runs inside its container, so the editor can tell the
 * user what `./uploads` in their code is called here.
 */
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

/** The kind of a row, defaulting the absent discriminant to "named". */
export function kindOf(v: Pick<VolumeMount, "type">): VolumeKind {
  return v.type ?? "named";
}

export function metaOf(v: Pick<VolumeMount, "type">): VolumeKindMeta {
  return VOLUME_KINDS[kindOf(v)];
}

/**
 * Container paths the runtime owns; mounting over them breaks or compromises the
 * container. Rejected as an exact match or as a parent prefix. Imported by the
 * server's `validateVolumes` so the editor and the writer share one list.
 */
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

/**
 * Whether this KIND of entry may not take `mountPath`, because the runtime owns
 * it.
 */
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

/** Docker's name shape for a managed volume (also blocks YAML key injection). */
export const VOLUME_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
export const VOLUME_NAME_MAX = 40;

/**
 * The `:`-suffixed options a `- source:target` mount line ends with.
 */
export function mountOptions(m: {
  readOnly?: boolean | null;
  propagation?: MountPropagation | null;
}): string {
  const opts = [m.readOnly ? "ro" : "", m.propagation ?? ""].filter(Boolean);
  return opts.length ? `:${opts.join(",")}` : "";
}

/** The propagation named in a mount line's option list, if any. Inverse of
 *  {@link mountOptions}, for the reroute path that reads the deployed stack. */
export function parseMountPropagation(
  opts: string[],
): MountPropagation | undefined {
  return MOUNT_PROPAGATIONS.find((p) => opts.includes(p));
}

/**
 * The one normaliser for a File entry's path in this app's Files: trimmed, the
 * optional `./` marker dropped (the same prefix the compose convention uses), no
 * trailing slash.
 */
export function normalizeFilesPath(path: string | null | undefined): string {
  return (path ?? "")
    .trim()
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

/** The last segment of a path — `/srv/media` → `media`. Empty for `/`, `.`, `..`. */
function lastSegment(path: string): string {
  const segments = (path ?? "").trim().replace(/\/+$/, "").split("/");
  const last = segments[segments.length - 1] ?? "";
  return last === "." || last === ".." ? "" : last;
}

/**
 * The file name a mount path ends in — `/etc/nginx/nginx.conf` → `nginx.conf`.
 */
export function filesPathFromMountPath(mountPath: string): string {
  return lastSegment(mountPath);
}

/**
 * Where a row lands inside the container when the user does not say — the reason
 * "Path inside the app" is not a field you must fill.
 */
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
        : // As typed, NOT case-folded: a path inside a Linux container is
          // case-sensitive, so a Volume named `Uploads` has to land on `/app/Uploads` — the
          // folder the code writes to.
          (v.name ?? "").trim();
  if (!rel) return "";
  return `${workdir.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`;
}

/**
 * The path this row will really mount at: what the user typed, or else {@link
 * derivedMountPath}.
 */
export function effectiveMountPath(
  v: VolumeMount,
  workdir?: string | null,
): string {
  return (
    (v.mountPath ?? "").trim().replace(/\/+$/, "") ||
    derivedMountPath(v, workdir)
  );
}

/** A docker-volume-safe name derived from a mount path when the name is blank
 *  (e.g. "/var/data" → "var-data", "/" → "data"). The server derives the SAME
 *  name (it re-exports this), so the editor's preview is not a guess. */
export function deriveVolumeName(mountPath: string): string {
  const s = mountPath
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "data";
}

/**
 * Which field of a row is wrong, and what to say about it.
 */
export interface VolumeProblem {
  field: "source" | "mountPath";
  message: string;
}

export function volumeProblem(
  v: VolumeMount,
  workdir?: string | null,
): VolumeProblem | null {
  const kind = kindOf(v);

  // The SOURCE is checked first, and not only because the form asks for it first:
  // with a known working directory it is also what the path inside the app is derived
  // from, so a row with neither has a missing source, not a missing path.
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
    // Volume: a blank name is fine on its own — the server derives one from the
    // path (and the path may in turn be derived from the name, which is why the
    // "one of the two" rule lives below rather than here).
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
    // A Volume is the one kind whose source may be left blank, so this is where
    // its "name it or place it" requirement lands — and with a working directory
    // to derive from, naming it is the shorter of the two.
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

/**
 * The problem the SET has, which no single row can see: two mounts at the same
 * path in the same container, or two managed volumes sharing a name (their on-host
 * name would collide).
 */
export function volumeSetProblem(
  volumes: VolumeMount[],
  workdir?: string | null,
): string | null {
  const paths = new Set<string>();
  const names = new Set<string>();
  for (const v of volumes) {
    // The path that will be STORED, derived ones included: two rows that leave
    // the path empty and land on the same one still collide.
    const path = effectiveMountPath(v, workdir);
    if (path) {
      // JSON, not a joined string: it keeps the two parts apart with no
      // separator character that a service name or a path could contain.
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

/**
 * The on-host name a Volume row will use, for the copyable target line. Null for
 * a File or a Bind (their source IS the target, already on screen) and for a
 * Volume with no path yet, which has nothing to derive a name from.
 */
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

/**
 * One sentence stating what this row will DO at deploy — the honest readout that
 * replaces guessing from three half-filled inputs. `slug` is the app's, for the
 * on-host volume name.
 */
export function volumeReadout(
  v: VolumeMount,
  slug: string,
  workdir?: string | null,
): string {
  const kind = kindOf(v);
  // The path it will really use — a derived one reads exactly like a typed one,
  // because at deploy there is no difference between them.
  const at = effectiveMountPath(v, workdir);
  const ro = v.readOnly ? " The app can read it but not change it." : "";
  if (kind === "host") {
    const from = (v.hostPath ?? "").trim();
    if (!from || !at)
      return "Shares a folder that already exists on the server.";
    // Stated only when it is ON: the default (a snapshot of what was mounted at
    // startup) is what every other kind does too, so saying it would be noise.
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
  if (!at) return "deplo creates the disk once you give it a name or a path.";
  const name = ((v.name ?? "").trim() || deriveVolumeName(at)).toLowerCase();
  return `Keeps ${at} on a disk deplo manages (${hostVolumeName(slug, name)}). It survives every deploy.${ro}`;
}
