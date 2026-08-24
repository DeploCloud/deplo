/**
 * Plugin catalog + manifest contract — PURE.
 *
 * **DORMANT (ADR-0013).** The Plugins feature is deferred, so nothing fetches or
 * installs a manifest today: this module is the wire contract kept ready for the
 * feature's return, and it is the one piece of it with no host coupling at all.
 * The catalog CLIENT that used to fetch these documents is gone on purpose — it
 * defaulted to a private host, and where a catalog is served from is an open
 * question ADR-0013 leaves to the revival.
 *
 * The shapes a plugin repository serves (`catalog.json` and each
 * `plugins/<id>/manifest.json`), their zod validators, and the install-time
 * placeholder resolver. No `server-only`, no docker, no fetch — types in,
 * validated values out, so this is its own test surface. The runtime
 * (`./runtime`) builds on top of it.
 *
 * A manifest's `image` and `env` values are treated as OPAQUE — never eval'd.
 * The only thing Deplo interprets is the `${…}` placeholder grammar in env
 * values, resolved here against a small, closed set of known substitutions.
 */

import { randomBytes } from "node:crypto";
import { z } from "zod";

/** A url-safe random token of `bytes` bytes — the same shape as crypto's
 * `randomToken`, inlined from `node:crypto` so this module stays pure (no
 * `server-only` taint) and unit-testable. */
function randomToken(bytes: number): string {
  return randomBytes(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/* ------------------------------------------------------------------ */
/* Schemas (the wire contract)                                         */
/* ------------------------------------------------------------------ */

/** A single entry in the repository's `catalog.json`. */
export const PluginListingSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    // Slug-safe: the id seeds the container name and the plugin-path slug.
    .regex(
      /^[a-z0-9-]+$/,
      "plugin id must be lowercase letters, digits and dashes",
    ),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(""),
  version: z.string().min(1).max(64),
  logo: z.string().max(512).optional(),
  tags: z.array(z.string().max(48)).max(24).default([]),
  /** Relative path on the repository host, e.g. `/plugins/relay/manifest.json`. */
  manifestUrl: z.string().min(1).max(512),
});

export type PluginListing = z.infer<typeof PluginListingSchema>;

export const PluginCatalogSchema = z.array(PluginListingSchema).max(256);

/** One env var the plugin's container receives. `value` may carry placeholders. */
export const PluginEnvVarSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(256)
    .regex(
      /^[A-Za-z_][A-Za-z0-9_]*$/,
      "env key must be a valid shell identifier",
    ),
  value: z.string().max(4096),
});

export type PluginEnvVar = z.infer<typeof PluginEnvVarSchema>;

/** The container port the plugin path forwards to. NOT a domain/Traefik Host. */
export const PluginExposeSchema = z.object({
  port: z.number().int().min(1).max(65535),
});

export type PluginExpose = z.infer<typeof PluginExposeSchema>;

/** `plugins/<id>/manifest.json` — the install spec for one plugin. */
export const PluginManifestSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(
      /^[a-z0-9-]+$/,
      "plugin id must be lowercase letters, digits and dashes",
    ),
  name: z.string().min(1).max(120),
  version: z.string().min(1).max(64),
  /** The runnable image ref. Opaque — handed to docker, never parsed/eval'd. */
  image: z.string().min(1).max(512),
  /** The container port the plugin path forwards to. */
  expose: PluginExposeSchema,
  env: z.array(PluginEnvVarSchema).max(64).default([]),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/* ------------------------------------------------------------------ */
/* Placeholder resolution                                              */
/* ------------------------------------------------------------------ */

/**
 * The closed set of context values a manifest env placeholder may reference.
 * Exactly one today (`deplo_graphql_url`) — a plugin that needs to call back into
 * Deplo's own API. Anything not listed here is a hard error: a manifest can never
 * reach into arbitrary Deplo state.
 */
export interface PlaceholderContext {
  /** `${deplo_graphql_url}` → Deplo's own `…/api/graphql` endpoint. */
  deploGraphqlUrl: string;
}

/** A placeholder the resolver understood but found unresolvable / malformed. */
export class PlaceholderError extends Error {}

/**
 * Resolve every `${…}` placeholder in a manifest's env into concrete values.
 *
 * Supported grammar (everything else is rejected):
 *   - `${deplo_graphql_url}`  → `ctx.deploGraphqlUrl` (injected by Deplo)
 *   - `${secret:N}`           → a fresh random token of N bytes. 1 ≤ N ≤ 256.
 *                               NOTE (ADR-0013): this mints a NEW value on every
 *                               resolve and `installed_plugins` persists no env,
 *                               so a reinstall silently rotates it — fine for a
 *                               stateless plugin, destructive for a stateful one.
 *                               Settle that before the feature ships.
 *
 * A value with no placeholder passes through verbatim. The image and other
 * manifest fields are never touched here — only env values are interpolated.
 * Throws `PlaceholderError` on an unknown or malformed placeholder so install
 * fails loudly rather than shipping a literal `${…}` into the container.
 */
export function resolvePluginEnv(
  env: PluginEnvVar[],
  ctx: PlaceholderContext,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of env) {
    out[key] = value.replace(/\$\{([^}]+)\}/g, (_m, token: string) => {
      const t = token.trim();
      if (t === "deplo_graphql_url") return ctx.deploGraphqlUrl;
      const secret = /^secret:(\d+)$/.exec(t);
      if (secret) {
        const n = Number(secret[1]);
        if (!Number.isInteger(n) || n < 1 || n > 256) {
          throw new PlaceholderError(`invalid secret length in \${${t}}`);
        }
        return randomToken(n);
      }
      throw new PlaceholderError(`unknown placeholder \${${t}} in env ${key}`);
    });
  }
  return out;
}
