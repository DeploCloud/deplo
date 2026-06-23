import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { formatDistanceToNowStrict } from "date-fns";
import prettyBytes from "pretty-bytes";

/** Merge Tailwind classes with conflict resolution. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Human-readable byte count (powered by `pretty-bytes`). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "";
  return prettyBytes(Math.max(0, bytes));
}

/** Relative "time ago" formatting (powered by `date-fns`). */
export function timeAgo(input: Date | string | number): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return "";
  return formatDistanceToNowStrict(date, { addSuffix: true });
}

/** Title-case a slug or kebab string. */
export function titleCase(input: string): string {
  return input.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Display name for a server — the operator-chosen name. */
export function serverLabel(server: { name: string }): string {
  return server.name;
}

/** Human label for a deploy source. */
export function deploySourceLabel(source: string): string {
  switch (source) {
    case "github":
      return "GitHub";
    case "git":
      return "Git repository";
    case "docker-image":
      return "Docker image";
    case "upload":
      return "Upload";
    case "compose":
      return "Docker Compose";
    default:
      return titleCase(source);
  }
}

/**
 * Whether a project deploys its own docker-compose stack rather than a single
 * built/pulled image. `compose` is authoritative; the legacy heuristic (a
 * stored compose with no repo/image) catches template projects created before
 * the `compose` source existed. An "upload" source is always a single-image
 * build, so it is excluded even if a stale compose lingers from a former source
 * (setProjectUpload nulls repo/image but keeps compose for switching back).
 *
 * One source of truth so the deploy pipeline (runDeployment, rerouteProject)
 * and the settings UI can never disagree about whether a project is a stack.
 */
export function usesComposeStack(project: {
  source: string;
  compose: string | null;
  repo: unknown | null;
  dockerImage: string | null;
}): boolean {
  const hasCompose = Boolean(project.compose && project.compose.trim());
  return (
    project.source === "compose" ||
    (project.source !== "upload" &&
      hasCompose &&
      !project.repo &&
      !project.dockerImage)
  );
}

/**
 * The host-global docker volume name for a single-container project's named
 * volume. A volume name is GLOBAL on the daemon (like container_name was —
 * compose strips it to avoid collisions) and the host is shared across teams,
 * so it MUST be namespaced per project. Derived from the slug at render time
 * (never stored) so a rename can't orphan data and `name` stays a label.
 */
export function hostVolumeName(slug: string, name: string): string {
  return `deplo-${slug}-${name}`;
}

/**
 * Validate a user-typed colour without throwing — accepts `#rgb`/`#rrggbb`
 * (with or without the leading `#`, any case). Used for live client-side input
 * validation; {@link normalizeHexColor} is the throwing, normalising sibling
 * used at the trust boundary (the data layer).
 */
export function isHexColor(input: string): boolean {
  return /^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(input.trim());
}

/**
 * Normalise a colour to a canonical lowercase `#rrggbb`, expanding the `#rgb`
 * shorthand and tolerating a missing `#`. Throws on anything that is not a valid
 * hex colour, so callers can persist the result verbatim and every stored colour
 * is the same shape (cheap parsing in {@link readableTextColor}).
 */
export function normalizeHexColor(input: string): string {
  const raw = input.trim().replace(/^#/, "").toLowerCase();
  if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(raw)) {
    throw new Error("Enter a valid hex colour, e.g. #3b82f6.");
  }
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;
  return `#${full}`;
}

/**
 * Pick the readable foreground (`#000000` or `#ffffff`) for text/icons placed on
 * a solid `hex` background — automatic contrast. Uses the WCAG relative
 * luminance with the 0.179 crossover (the luminance at which black and white
 * text have equal contrast), so a folder's chosen colour never produces an
 * unreadable label. Defensive: an unparseable colour falls back to dark text.
 */
export function readableTextColor(hex: string): "#000000" | "#ffffff" {
  // Parse defensively (no throwing): tolerate a missing `#`, any case, and the
  // `#rgb` shorthand; anything unparseable falls back to dark text.
  const raw = hex.trim().replace(/^#/, "").toLowerCase();
  const full = /^[0-9a-f]{3}$/.test(raw)
    ? raw
        .split("")
        .map((c) => c + c)
        .join("")
    : raw;
  if (!/^[0-9a-f]{6}$/.test(full)) return "#000000";
  const n = parseInt(full, 16);
  const channels = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const lum =
    0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  return lum > 0.179 ? "#000000" : "#ffffff";
}

/** Deterministic short id for client-only keys (not for security). */
export function shortId(length = 8): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
