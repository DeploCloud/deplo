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

/** Display name for a server: the host running Deplo is the "master". */
export function serverLabel(server: {
  name: string;
  type: "localhost" | "remote";
}): string {
  if (server.type === "localhost") return "Master (this host)";
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

/** Deterministic short id for client-only keys (not for security). */
export function shortId(length = 8): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
