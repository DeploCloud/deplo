import { builder } from "../builder";
import { ALL_CAPABILITIES } from "@/lib/types";
import {
  LEGACY_CAPABILITY_EXPANSION,
  LEGACY_CAPABILITY_NAMES,
} from "@/lib/capabilities";

/**
 * Enums lifted from the domain types in `lib/types.ts`.
 */

export const RoleEnum = builder.enumType("Role", {
  values: ["owner", "member", "viewer"] as const,
});

/**
 * Every capability, plus the eight coarse names they replaced - kept as DEPRECATED
 * input aliases so a script written against the old API keeps working: each still
 * expands to exactly the permissions it used to imply (`cleanCapabilities` /
 * `sanitizeCapabilities` do the expanding).
 */
export const CapabilityEnum = builder.enumType("Capability", {
  values: Object.fromEntries([
    ...ALL_CAPABILITIES.map((c) => [c, { value: c }]),
    ...LEGACY_CAPABILITY_NAMES.filter(
      (n) => !(ALL_CAPABILITIES as string[]).includes(n),
    ).map((n) => [
      n,
      {
        value: n,
        deprecationReason: `Split into finer permissions. Still accepted on input, where it means: ${LEGACY_CAPABILITY_EXPANSION[n].join(", ")}.`,
      },
    ]),
  ]) as Record<string, { value: string; deprecationReason?: string }>,
});

export const AppStatusEnum = builder.enumType("AppStatus", {
  values: [
    "active",
    "building",
    "error",
    "queued",
    "idle",
    "stopping",
    "restoring",
  ] as const,
});

// GraphQL enum value names must match /[_a-zA-Z0-9]/, but some of the domain unions
// use hyphens (e.g. "docker-image").
export const DeploySourceEnum = builder.enumType("DeploySource", {
  values: {
    GITHUB: { value: "github" },
    GIT: { value: "git" },
    DOCKER_IMAGE: { value: "docker-image" },
    UPLOAD: { value: "upload" },
    COMPOSE: { value: "compose" },
  } as const,
});

export const DeploymentStatusEnum = builder.enumType("DeploymentStatus", {
  values: ["queued", "building", "ready", "error", "canceled"] as const,
});

export const DeploymentEnvironmentEnum = builder.enumType(
  "DeploymentEnvironment",
  { values: ["production", "preview"] as const },
);

export const EnvTargetEnum = builder.enumType("EnvTarget", {
  values: ["production", "preview"] as const,
});

export const DatabaseTypeEnum = builder.enumType("DatabaseType", {
  values: [
    "postgres",
    "mysql",
    "mariadb",
    "mongodb",
    "redis",
    "clickhouse",
  ] as const,
});

// The one enum in this module carrying per-value descriptions, because one of its
// values means something a caller cannot guess from its name: `cloudflare` reads
// like a success and is NOT one.
export const DomainStatusEnum = builder.enumType("DomainStatus", {
  description: "A custom domain's DNS verification state.",
  values: {
    valid: {
      value: "valid",
      description:
        "An A record resolves straight to this app's server: confirmed, and routed.",
    },
    cloudflare: {
      value: "cloudflare",
      description:
        "Proxied through Cloudflare's orange-cloud. UNVERIFIED - treat as an " +
        "open question, not a success. The host resolves to Cloudflare's " +
        "anycast IPs, which are shared by every proxied domain on the internet " +
        "and mask the origin, so public DNS can show only that the domain is " +
        "proxied, never whether Cloudflare forwards it to this app's server " +
        "or to somebody else's. The domain is routed regardless (it must be, " +
        "or a correct setup could never work), but nothing has been confirmed.",
    },
    pending: {
      value: "pending",
      description:
        "No A record resolves yet - the normal state of a record just created. Re-checked automatically.",
    },
    misconfigured: {
      value: "misconfigured",
      description:
        "Resolves to an address that is neither this app's server nor a " +
        "Cloudflare edge. Not routed, unless `Domain.proxied` says another " +
        "proxy answers for it.",
    },
    error: {
      value: "error",
      description: "A check failed unexpectedly (reserved).",
    },
  } as const,
});

export const S3ProviderEnum = builder.enumType("S3Provider", {
  values: {
    AWS: { value: "aws" },
    CLOUDFLARE_R2: { value: "cloudflare-r2" },
    BACKBLAZE_B2: { value: "backblaze-b2" },
    MINIO: { value: "minio" },
    DIGITALOCEAN: { value: "digitalocean" },
    WASABI: { value: "wasabi" },
    OTHER: { value: "other" },
  } as const,
});

export const RegistryTypeEnum = builder.enumType("RegistryType", {
  values: ["ghcr", "dockerhub", "gitlab", "generic"] as const,
});
