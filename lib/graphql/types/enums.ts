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

export const ServiceStatusEnum = builder.enumType("ServiceStatus", {
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
  values: ["production", "preview", "development"] as const,
});

export const DatabaseTypeEnum = builder.enumType("DatabaseType", {
  values: ["postgres", "mysql", "mariadb", "mongodb", "redis", "clickhouse"] as const,
});

export const DomainStatusEnum = builder.enumType("DomainStatus", {
  values: ["valid", "cloudflare", "pending", "misconfigured", "error"] as const,
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
