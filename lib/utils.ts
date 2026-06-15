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
    case "dockerfile":
      return "Dockerfile";
    case "upload":
      return "Upload";
    default:
      return titleCase(source);
  }
}

/** Deterministic short id for client-only keys (not for security). */
export function shortId(length = 8): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
