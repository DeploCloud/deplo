// Type-only (erased at runtime), so the framework catalog can keep importing
// BuildMethod from here without either module ever forming a runtime cycle.
import type { FrameworkId } from "../apps/framework-catalog";
import type { ID } from "./identity";
import type { BuildConfig, GitRepo } from "./build";
import type {
  HealthCheck,
  PublishedPort,
  ResourceLimits,
  VolumeMount,
} from "./container";

export type AppStatus =
  | "active"
  | "building"
  | "error"
  | "queued"
  | "idle"
  // Transient, persisted so it survives reload: the user pressed Stop and the
  // container is coming down, until the project settles to "idle".
  | "stopping"
  // Transient: a backup is being put back in place.
  | "restoring";

// DeploySource - where a project's code/image comes from.
export type DeploySource =
  "github" | "git" | "docker-image" | "upload" | "compose";

// deploySourceEnumName - the GraphQL `DeploySource` enum exposes uppercase,
// underscored value names (GITHUB, DOCKER_IMAGE …): enum names can't hold hyphens.
export function deploySourceEnumName(source: DeploySource): string {
  return source.replace(/-/g, "_").toUpperCase();
}

// UploadArchive - a code archive uploaded from the dashboard, backing an
// "upload" source. Built exactly like a git clone.
export interface UploadArchive {
  // Opaque id, also the on-disk basename (minus extension).
  id: ID;
  // Original filename as uploaded, for display (e.g. "my-app.tar.gz").
  filename: string;
  // Absolute path to the stored archive on the host running Deplo.
  path: string;
  size: number;
  uploadedAt: string;
}

export interface App {
  id: ID;
  name: string;
  slug: string;
  teamId: ID;
  // The folder this project lives in on the Overview, null when ungrouped.
  folderId?: ID | null;
  // The {@link Project} this app belongs to (ADR-0008, additive).
  projectId?: ID | null;
  // The {@link Environment} this app LIVES in - ADR-0009's membership axis.
  // null/absent outside a project.
  environmentId?: ID | null;
  serverId: ID;
  // Set on a server MOVE when the OLD server still holds this app's data: the
  // source host the next successful deploy must copy the volumes + files from.
  migrateFromServerId?: ID | null;
  // Why this app's data did not arrive, when a migration tried to copy it and
  // could not. Empty string in the common case.
  dataCopyError: string;
  // The migration still creating this app, or null.
  migrationRunId: ID | null;
  // Which server BUILDS this app's image, when that is not `serverId`. null is
  // "Automatic": a build-only server this team can reach with a matching arch,
  // otherwise build where the app runs.
  buildServerId?: ID | null;
  // Build somewhere else when this app's build server cannot. false fails the
  // deploy instead, for whoever picked a small deploy server on purpose.
  buildFallback: boolean;
  // Display logo (a URL or local /templates/<x> path), NOT the Docker image.
  logo: string | null;
  // The plate {@link logo} needs to stay visible on both themes, read from its
  // own pixels. Set only for a template logo; an upload or a detected favicon
  // leaves it null and is drawn exactly as it is.
  logoTone: "dark" | "light" | null;
  // The framework Deplo recognised in this app's source, or null - only the
  // auto-detecting builders (Nixpacks / Railpack) set it.
  framework: FrameworkId | null;
  // The framework the user picked because detection got it wrong; null trusts
  // detection.
  frameworkOverride: FrameworkId | null;
  source: DeploySource;
  repo: GitRepo | null;
  // Image reference when source is "docker-image" (e.g. ghcr.io/org/app:tag).
  dockerImage: string | null;
  // The code archive currently backing an "upload" source. Re-uploading replaces it.
  upload: UploadArchive | null;
  // Editable docker-compose stack for template/compose deploys (else null).
  compose: string | null;
  // Config files a template bind-mounts into its stack, written next to the
  // stack at deploy time with the same generated secrets the env uses.
  mounts?: { filePath: string; content: string }[] | null;
  // User-managed volumes for the SINGLE-CONTAINER deploy path (renderCompose).
  // null/absent for compose stacks and apps that never added one, so no
  // `volumes:` key is emitted and the stack stays byte-identical.
  volumes?: VolumeMount[] | null;
  // Host ports this app publishes. null/absent for a compose stack (its YAML
  // publishes its own) and for every app that never added one.
  ports?: PublishedPort[] | null;
  build: BuildConfig;
  productionUrl: string | null;
  status: AppStatus;
  autoDeploy: boolean;
  // Pull request previews are ON for this app.
  previewEnabled: boolean;
  // Cron jobs are ON for this app - it rides the App because the sidebar decides
  // whether to offer the Cron jobs page from it.
  cronEnabled: boolean;
  // The container console is ON for this app - rides the App like `cronEnabled`.
  consoleEnabled: boolean;
  // Whether this app's deploy hook answers at all.
  deployHookEnabled: boolean;
  // Extra flags appended to the `docker compose up` that brings it up, as the
  // operator typed them, or null for the untouched command.
  composeUpArgs: string | null;
  // How many previous deployments this app can be rolled back to (default 3).
  rollbackKeep: number;
  // Per-app resource caps applied at deploy time, or null for no limits.
  resources: ResourceLimits | null;
  // Null when the app has no health check - which is the default.
  healthCheck: HealthCheck | null;
  latestDeploymentId: ID | null;
  // When someone confirmed this app's deletion. Treat it as gone: every gate
  // refuses a stamped app, its pages 404, and no user-facing list returns it.
  deletingAt?: string | null;
  // When config was last saved without being deployed since. Cleared by the next
  // successful deploy.
  pendingChangesAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

// DEFAULT_ROLLBACK_KEEP - how many previous deployments a new app can be rolled
// back to.
export const DEFAULT_ROLLBACK_KEEP = 3;

// MAX_ROLLBACK_KEEP - the ceiling on {@link App.rollbackKeep}. Retention is disk:
// past this, an app hoards images nobody will roll back to. `0` keeps nothing.
export const MAX_ROLLBACK_KEEP = 20;
