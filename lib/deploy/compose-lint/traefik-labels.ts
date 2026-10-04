import { interpolates } from "./document";

// Kinds that only reshape the app's own traffic: none dials an address, reads a proxy file or names another piece.
const MIDDLEWARE_KINDS = new Set([
  "headers",
  "compress",
  "ratelimit",
  "inflightreq",
  "ipallowlist",
  "ipwhitelist",
  "redirectscheme",
  "redirectregex",
  "addprefix",
  "stripprefix",
  "stripprefixregex",
  "replacepath",
  "replacepathregex",
  "buffering",
  "retry",
  "circuitbreaker",
  "contenttype",
  "grpcweb",
  "basicauth",
  "digestauth",
]);
const DENIED_OPTIONS = [
  "basicauth.usersfile",
  "digestauth.usersfile",
  "ratelimit.redis",
];
// Deplo decides these itself, so dropping them is not worth a warning.
const OWNED_KEYS = new Set(["traefik.enable", "traefik.docker.network"]);

export type TraefikLabel =
  | { kind: "other" }
  | { kind: "owned" }
  | { kind: "ignored" }
  | { kind: "middleware"; name: string; option: string };

export function readTraefikLabel(key: string): TraefikLabel {
  const k = key.trim();
  if (interpolates(k)) return { kind: "ignored" };
  if (!/^traefik\./i.test(k)) return { kind: "other" };
  if (OWNED_KEYS.has(k.toLowerCase())) return { kind: "owned" };
  const m =
    /^traefik\.http\.middlewares\.([A-Za-z0-9_-]+)\.(([A-Za-z]+)(\..+)?)$/i.exec(
      k,
    );
  if (!m || !MIDDLEWARE_KINDS.has(m[3].toLowerCase()))
    return { kind: "ignored" };
  const option = m[2].toLowerCase();
  if (DENIED_OPTIONS.some((d) => option === d || option.startsWith(`${d}.`)))
    return { kind: "ignored" };
  return { kind: "middleware", name: m[1], option: m[2] };
}

export function labelEntries(labels: unknown): [string, string | undefined][] {
  if (Array.isArray(labels))
    return labels
      .filter((l): l is string => typeof l === "string")
      .map((l) => {
        const at = l.indexOf("=");
        return at < 0 ? [l, undefined] : [l.slice(0, at), l.slice(at + 1)];
      });
  if (labels && typeof labels === "object")
    return Object.entries(labels as Record<string, unknown>).map(([k, v]) => [
      k,
      String(v),
    ]);
  return [];
}

export function ignoredTraefikKeys(labels: unknown): string[] {
  return labelEntries(labels)
    .map(([key]) => key)
    .filter((key) => readTraefikLabel(key).kind === "ignored");
}

export function ignoredTraefikMessage(service: string, keys: string[]): string {
  const shown = keys.slice(0, 4).map((k) => `\`${k}\``);
  const more = keys.length > 4 ? ` and ${keys.length - 4} more` : "";
  return (
    `\`${service}\` has Traefik labels Deplo does not apply: ${shown.join(", ")}${more}. ` +
    `Routes come from the app's Domains; a supported middleware is kept and applied to this service's domains.`
  );
}
