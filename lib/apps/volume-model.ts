import { hostVolumeName } from "../utils";
import type { VolumeMount } from "../types";

/**
 * The pure model behind the Storage settings editor: what the three kinds of
 * mount ARE in the UI's words, and the one validator both the editor's inline
 * lint and the save-time check run. No React, so it unit-tests directly (the
 * same split as `resource-limits-model` / `breadcrumb-model`).
 *
 * NAMING — the UI says **Volume**, **File**, **Bind**; the STORED discriminants
 * stay `"named"`, `"app"`, `"host"` forever. "Named volume" / "App file" /
 * "Host path" were the old labels and nobody could tell what a "named volume"
 * was, which is exactly the Docker vocabulary deplo exists to keep off the
 * screen. Renaming the stored values would have been a migration for a caption,
 * so the mapping lives here and nowhere else.
 *
 * The RULES are shared with the server on purpose: `validateVolumes`
 * (lib/data/apps.ts) imports {@link RESERVED_MOUNT_PREFIXES} and
 * {@link VOLUME_NAME_RE} from here, so the editor cannot accept something the
 * writer will reject, and neither can drift from the other. Wording differs by
 * design — the server's messages are API errors, the ones here are what a user
 * reads while typing.
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
   * Volume only: what the derived on-host name row is called. Null ⇒ no target
   * row. File and Bind get none on purpose — their target would just echo back
   * the path the user typed one line above, and a File's real absolute source
   * (`<stacks>/files/<slug>/…`) is not knowable client-side, so printing one
   * would be an invention.
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
    examples: "Only when the data is already on that machine, or something outside deplo uses it too.",
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
 * Switch a row's kind, KEEPING each kind's own source value.
 *
 * Preserving is safe because nothing but the selected kind's field can ever
 * leave: the editor renders only that field, the readout only describes that
 * kind, and both the save payload and the dirty key are type-gated (a `name`
 * typed for a Volume is not sent for a Bind row — see `storage-settings-form`).
 * Given that, preserving beats clearing: a non-expert who clicks the wrong card
 * undoes it with one click instead of retyping.
 *
 * The no-op guard is load-bearing, not a micro-optimisation. A saved Volume row
 * comes back with `type` ABSENT (the back-compat default), so re-picking Volume
 * would write `type: "named"` and arm the unsaved-changes guard over a change
 * nobody made.
 */
export function switchKind(v: VolumeMount, kind: VolumeKind): VolumeMount {
  if (kind === kindOf(v)) return v;
  return { ...v, type: kind };
}

/**
 * Where a BUILT app's code runs inside its container, so the editor can tell the
 * user what `./uploads` in their code is called here. deplo's generated
 * Dockerfile sets `WORKDIR /app` (or `/app/<root directory>`) — see
 * `lib/deploy/dockerfile.ts` — and the buildpack images (Nixpacks, Railpack) use
 * `/app` too, so for anything deplo builds this is a fact, not a guess.
 *
 * Null for a prebuilt `docker-image` app: that image chose its own working
 * directory and deplo has no way to know it, so the editor must not invent one.
 */
export function containerWorkdir(
  source: string,
  rootDirectory: string | null | undefined,
): string | null {
  if (source === "docker-image" || source === "compose") return null;
  const root = (rootDirectory || ".").replace(/^\.?\/+/, "").replace(/\/+$/, "");
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

/** Docker's name shape for a managed volume (also blocks YAML key injection). */
export const VOLUME_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
export const VOLUME_NAME_MAX = 40;

/**
 * The one normaliser for a File entry's path in this app's Files: trimmed, the
 * optional `./` marker dropped (the same prefix the compose convention uses),
 * no trailing slash. The editor, the dirty key, the content read and the save
 * all key off this, so a path typed as `./conf/app.toml` is the same file as
 * `conf/app.toml` everywhere instead of only after a round trip. The server's
 * `validateVolumes` normalises identically.
 */
export function normalizeFilesPath(path: string | null | undefined): string {
  return (path ?? "").trim().replace(/^\.\/+/, "").replace(/\/+$/, "");
}

/**
 * The file name a mount path ends in — `/etc/nginx/nginx.conf` → `nginx.conf`.
 * The editor offers this as the path in Files while the user has not written one
 * of their own, so the commonest File entry (one file, same name both sides) is
 * one field instead of two. Empty when the path has no last segment yet.
 */
export function filesPathFromMountPath(mountPath: string): string {
  const segments = (mountPath ?? "").trim().replace(/\/+$/, "").split("/");
  const last = segments[segments.length - 1] ?? "";
  return last === "." || last === ".." ? "" : last;
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
 * Which field of a row is wrong, and what to say about it. Null ⇒ the row is
 * fine. Mirrors the server's rules exactly (it shares the constants above); the
 * copy is what the user reads next to the input as they type, so it names the
 * field by its UI label rather than its wire name.
 *
 * `field` lets the editor ring the offending input instead of only printing a
 * message — the old form's first feedback was a toast on save, which meant
 * typing a bad path and finding out three clicks later.
 */
export interface VolumeProblem {
  field: "source" | "mountPath";
  message: string;
}

export function volumeProblem(v: VolumeMount): VolumeProblem | null {
  const kind = kindOf(v);
  const mountPath = (v.mountPath ?? "").trim().replace(/\/+$/, "");

  if (!mountPath) return { field: "mountPath", message: "Add a path inside the app" };
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
  if (
    RESERVED_MOUNT_PREFIXES.some(
      (r) => mountPath === r || mountPath.startsWith(r + "/"),
    )
  )
    return {
      field: "mountPath",
      message: `${mountPath} belongs to the system and cannot be replaced`,
    };

  if (kind === "host") {
    const hostPath = (v.hostPath ?? "").trim().replace(/\/+$/, "");
    if (!hostPath)
      return { field: "source", message: "Add the folder's path on the server" };
    if (!hostPath.startsWith("/") || hostPath.length < 2)
      return {
        field: "source",
        message: "The path on the server must start with a slash, like /srv/media",
      };
    if (/[\s:]/.test(hostPath))
      return {
        field: "source",
        message: 'The path on the server cannot contain spaces or ":"',
      };
    if (hostPath.split("/").includes(".."))
      return { field: "source", message: 'The path cannot contain ".."' };
    return null;
  }

  if (kind === "app") {
    const p = normalizeFilesPath(v.projectPath);
    if (!p)
      return { field: "source", message: "Add the file's path in this app's Files" };
    if (p.startsWith("/"))
      return {
        field: "source",
        message: "Use a path relative to this app's Files, like config.toml",
      };
    if (/[\s:]/.test(p))
      return { field: "source", message: 'The path cannot contain spaces or ":"' };
    if (p.split("/").includes(".."))
      return { field: "source", message: 'The path cannot contain ".."' };
    return null;
  }

  // Volume: a blank name is fine (the server derives one from the path).
  const name = (v.name ?? "").trim().toLowerCase();
  if (!name) return null;
  if (!VOLUME_NAME_RE.test(name))
    return {
      field: "source",
      message: "Use lowercase letters, digits, - or _ , starting with a letter or digit",
    };
  if (name.length > VOLUME_NAME_MAX)
    return {
      field: "source",
      message: `Keep the name under ${VOLUME_NAME_MAX + 1} characters`,
    };
  return null;
}

/**
 * The problem the SET has, which no single row can see: two mounts at the same
 * path in the same container, or two managed volumes sharing a name (their
 * on-host name would collide). Keyed per compose service, because two services
 * of one stack each mounting their own `/data` is normal.
 */
export function volumeSetProblem(volumes: VolumeMount[]): string | null {
  const paths = new Set<string>();
  const names = new Set<string>();
  for (const v of volumes) {
    const path = (v.mountPath ?? "").trim().replace(/\/+$/, "");
    if (path) {
      const key = `${(v.service ?? "").trim()} ${path}`;
      if (paths.has(key)) return `Two mounts share the path ${path}`;
      paths.add(key);
    }
    if (kindOf(v) === "named") {
      const name = ((v.name ?? "").trim() || deriveVolumeName(path)).toLowerCase();
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
export function namedVolumeTarget(v: VolumeMount, slug: string): string | null {
  if (kindOf(v) !== "named") return null;
  const path = (v.mountPath ?? "").trim();
  const name = (v.name ?? "").trim() || (path ? deriveVolumeName(path) : "");
  return name ? hostVolumeName(slug, name.toLowerCase()) : null;
}

/**
 * One sentence stating what this row will DO at deploy — the honest readout that
 * replaces guessing from three half-filled inputs. `slug` is the app's, for the
 * on-host volume name.
 */
export function volumeReadout(v: VolumeMount, slug: string): string {
  const kind = kindOf(v);
  const at = (v.mountPath ?? "").trim();
  const ro = v.readOnly ? " The app can read it but not change it." : "";
  if (kind === "host") {
    const from = (v.hostPath ?? "").trim();
    if (!from || !at) return "Shares a folder that already exists on the server.";
    return `Shares the server's ${from} at ${at} inside the app.${ro}`;
  }
  if (kind === "app") {
    const from = normalizeFilesPath(v.projectPath);
    if (!from || !at) return "Keeps a file you write here in this app's Files.";
    return `Keeps ${from} in this app's Files and puts it at ${at} inside the app.${ro}`;
  }
  if (!at) return "deplo creates the disk once you set a path inside the app.";
  const name = ((v.name ?? "").trim() || deriveVolumeName(at)).toLowerCase();
  return `Keeps ${at} on a disk deplo manages (${hostVolumeName(slug, name)}). It survives every deploy.${ro}`;
}
