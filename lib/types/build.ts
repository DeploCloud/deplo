import type { GitProviderId } from "./git";

// GitTriggerType - which git event auto-deploys: a push to the tracked branch,
// or any new tag. Absent/`undefined` is treated as "push".
export type GitTriggerType = "push" | "tag";

export interface GitRepo {
  provider: "github" | GitProviderId;
  url: string;
  repo: string; // owner/name
  branch: string;
  // For private GitHub repos cloned through a connected GitHub App: the
  // installation whose short-lived token authenticates the clone.
  installationId?: string | null;
  // For every OTHER host: the {@link GitConnection} whose stored token
  // authenticates the clone and registers the push webhook.
  connectionId?: string | null;
  // Which git event auto-deploys this app (see {@link GitTriggerType}).
  triggerType?: GitTriggerType;
  // Optional path globs (one per entry).
  watchPaths?: string[];
  // Clone the repository's git submodules (recurse-submodules) at build time.
  submodules?: boolean;
}

// BuildMethod - how Deplo turns a repository into a runnable image.
export type BuildMethod = "dockerfile" | "railpack" | "nixpacks" | "static";

// BuildMethodSettings - per-method build settings; only the fields relevant to
// the active `buildMethod` are surfaced in the UI and consumed at deploy time.
export interface BuildMethodSettings {
  // dockerfile: path to the Dockerfile, relative to the repo root.
  dockerfilePath?: string;
  // dockerfile: build context dir, relative to the repo root.
  dockerContextPath?: string;
  // dockerfile: optional `--target` build stage in a multi-stage Dockerfile.
  dockerBuildStage?: string;
  // railpack: builder image tag (e.g. "latest", "0.7").
  railpackVersion?: string;
  // nixpacks: after the build, serve just this directory as a static site.
  nixpacksPublishDirectory?: string;
  // static: serve as a single-page app (history-API fallback to index.html).
  staticSinglePageApp?: boolean;
}

export interface BuildConfig {
  // Which builder turns the repo into an image. Defaults to "railpack".
  buildMethod: BuildMethod;
  methodSettings: BuildMethodSettings;
  // Retained for the deploy builders and legacy rows; the command/runtime fields
  // below are no longer surfaced in the UI (the builders auto-detect them).
  rootDirectory: string;
  // Include files OUTSIDE the root directory in the build context.
  includeFilesOutsideRoot: boolean;
  // Skip an auto-deploy when an inbound push changed nothing inside the root
  // directory. Gates git push-triggered deploys only.
  skipUnchangedDeployments: boolean;
  // Reuse the owning server's Docker layer cache (and the builder's own cache
  // mounts) between this app's builds.
  buildCache: boolean;
  // Armed by "Clear build cache", consumed by the next build.
  buildCacheClearPending: boolean;
  // NULL is "Deplo works it out" - the builder detects it. An EMPTY STRING is a
  // deliberate "run nothing here". They were one value until migration 0147, so
  // a `?? ""` anywhere below is how the distinction quietly dies.
  installCommand: string | null;
  buildCommand: string | null;
  outputDirectory: string | null;
  startCommand: string | null;
  // Pinned runtime version, interpreted per language by the builder; empty means
  // "use the builder's default".
  runtimeVersion: string;
  // Container port Traefik routes to. The one build field still shown in the UI.
  port: number;
}
