import { randomBytes } from "node:crypto";
import { z } from "zod";

function randomToken(bytes: number): string {
  return randomBytes(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export const PluginListingSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(
      /^[a-z0-9-]+$/,
      "plugin id must be lowercase letters, digits and dashes",
    ),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(""),
  version: z.string().min(1).max(64),
  logo: z.string().max(512).optional(),
  tags: z.array(z.string().max(48)).max(24).default([]),
  manifestUrl: z.string().min(1).max(512),
});

export type PluginListing = z.infer<typeof PluginListingSchema>;

export const PluginCatalogSchema = z.array(PluginListingSchema).max(256);

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

export const PluginExposeSchema = z.object({
  port: z.number().int().min(1).max(65535),
});

export type PluginExpose = z.infer<typeof PluginExposeSchema>;

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
  image: z.string().min(1).max(512),
  expose: PluginExposeSchema,
  env: z.array(PluginEnvVarSchema).max(64).default([]),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export interface PlaceholderContext {
  deploGraphqlUrl: string;
}

export class PlaceholderError extends Error {}

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
