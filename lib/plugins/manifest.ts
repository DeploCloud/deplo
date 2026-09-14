import { randomBytes } from "node:crypto";
import { z } from "zod";

// Inlined instead of reusing lib/crypto: keeps this module free of the server-only taint.
function randomToken(bytes: number): string {
  return randomBytes(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// A single entry in the repository's `catalog.json`.
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
  // Relative path on the repository host, e.g. `/plugins/relay/manifest.json`.
  manifestUrl: z.string().min(1).max(512),
});

export type PluginListing = z.infer<typeof PluginListingSchema>;

export const PluginCatalogSchema = z.array(PluginListingSchema).max(256);

// One env var the plugin's container receives. `value` may carry placeholders.
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

// The container port the plugin path forwards to. NOT a domain/Traefik Host.
export const PluginExposeSchema = z.object({
  port: z.number().int().min(1).max(65535),
});

export type PluginExpose = z.infer<typeof PluginExposeSchema>;

// `plugins/<id>/manifest.json` - the install spec for one plugin.
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
  // The runnable image ref. Opaque - handed to docker, never parsed/eval'd.
  image: z.string().min(1).max(512),
  expose: PluginExposeSchema,
  env: z.array(PluginEnvVarSchema).max(64).default([]),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

// The closed set a manifest env placeholder may reference; anything else is a hard error, so a manifest can never reach into arbitrary Deplo state.
export interface PlaceholderContext {
  // `${deplo_graphql_url}` → Deplo's own `…/api/graphql` endpoint.
  deploGraphqlUrl: string;
}

// A placeholder the resolver understood but found unresolvable / malformed.
export class PlaceholderError extends Error {}

// Only env values are interpolated: the image and every other manifest field is never touched here.
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
