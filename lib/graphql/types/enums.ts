import { builder } from "../builder";
import { ALL_CAPABILITIES } from "@/lib/types";

/**
 * Enums lifted from the domain types in `lib/types.ts`. Each is exported as a
 * Pothos enum ref so domain modules reference the ref directly (type-safe across
 * modules) rather than by string name. The GraphQL schema stays a faithful,
 * single-sourced mirror of the TS unions.
 */

export const RoleEnum = builder.enumType("Role", {
  values: ["owner", "member", "viewer"] as const,
});

export const CapabilityEnum = builder.enumType("Capability", {
  values: ALL_CAPABILITIES,
});

export const AppStatusEnum = builder.enumType("AppStatus", {
  values: ["active", "building", "error", "queued", "idle", "stopping"] as const,
});

// GraphQL enum value names must match /[_a-zA-Z0-9]/, but some of the domain
// unions use hyphens (e.g. "docker-image"). Map the underscored GraphQL name to
// the hyphenated runtime value so the wire enum is valid and resolvers still
// receive the exact string the data layer expects.
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
  values: ["postgres", "mysql", "mariadb", "mongodb", "redis", "clickhouse"] as const,
});

// The one enum in this module carrying per-value descriptions, because one of
// its values means something a caller cannot guess from its name: `cloudflare`
// reads like a success and is NOT one. Spelling that out in the introspectable
// contract is the only way an API consumer (a CLI, a script, a dashboard of
// their own) can render it as honestly as deplo's own UI does.
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
        "Proxied through Cloudflare's orange-cloud. UNVERIFIED — treat as an " +
        "open question, not a success. The host resolves to Cloudflare's " +
        "anycast IPs, which are shared by every proxied domain on the internet " +
        "and mask the origin, so public DNS can show only that the domain is " +
        "proxied — never whether Cloudflare forwards it to this app's server " +
        "or to somebody else's. The domain is routed regardless (it must be, " +
        "or a correct setup could never work), but nothing has been confirmed.",
    },
    pending: {
      value: "pending",
      description:
        "No A record resolves yet — the normal state of a record just created. Re-checked automatically.",
    },
    misconfigured: {
      value: "misconfigured",
      description:
        "Resolves to an address that is neither this app's server nor a Cloudflare edge. Not routed.",
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
