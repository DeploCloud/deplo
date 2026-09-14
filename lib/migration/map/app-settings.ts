import { isValidLogoValue } from "../../apps/logo-shared";
import { HEALTH_CHECK_DEFAULTS } from "../../deploy/health-check";
import {
  MAX_PORT,
  MIN_USER_PORT,
  isValidExposePort,
} from "../../databases/ports";
import type { BuildConfig, BuildMethod } from "../../types/build";
import type {
  HealthCheck,
  PublishedPort,
  ResourceLimits,
} from "../../types/container";
import type { SourceApplication, SourceCompose } from "../model";

import { type Mapped, truncate } from "./source-platform";

/** Same shape as `ResourceLimitsInput` in lib/data/apps/resources.ts, without importing a
 *  `server-only` module into a file that must stay client-safe. */
export type ResourceInput = {
  [K in keyof ResourceLimits]?: ResourceLimits[K] | null;
};

const BUILD_METHOD: Record<string, BuildMethod> = {
  dockerfile: "dockerfile",
  nixpacks: "nixpacks",
  railpack: "railpack",
  static: "static",
  // Neither buildpack family has a Deplo equivalent. Nixpacks is the closest
  // thing: an auto-detecting builder that reads the same repos. Noted, never
  // silent - a Heroku buildpack with a custom `bin/compile` will not survive it.
  heroku_buildpacks: "nixpacks",
  paketo_buildpacks: "nixpacks",
};

/**
 * Dokploy's per-service build fields → Deplo's `BuildConfig`.
 */
export function mapBuildSettings(
  app: SourceApplication,
): Mapped<Partial<BuildConfig>> {
  const notes: string[] = [];
  const buildMethod = BUILD_METHOD[app.buildType] ?? "nixpacks";
  if (
    app.buildType === "heroku_buildpacks" ||
    app.buildType === "paketo_buildpacks"
  )
    notes.push(
      `Built with ${app.buildType.replace("_", " ")} on {panel}. Set to Nixpacks - check the build.`,
    );

  const build: Partial<BuildConfig> = { buildMethod };
  const methodSettings: BuildConfig["methodSettings"] = {};

  // ONLY the settings the chosen builder reads.
  if (buildMethod === "dockerfile") {
    if (app.dockerfile?.trim())
      methodSettings.dockerfilePath = app.dockerfile.trim();
    if (app.dockerContextPath?.trim())
      methodSettings.dockerContextPath = app.dockerContextPath.trim();
    if (app.dockerBuildStage?.trim())
      methodSettings.dockerBuildStage = app.dockerBuildStage.trim();
  }
  if (buildMethod === "railpack" && app.railpackVersion?.trim())
    methodSettings.railpackVersion = app.railpackVersion.trim();

  const publish = app.publishDirectory?.trim();
  if (buildMethod === "static") {
    if (publish) build.outputDirectory = publish;
    if (app.isStaticSpa) methodSettings.staticSinglePageApp = true;
  } else if (buildMethod === "nixpacks" && publish) {
    methodSettings.nixpacksPublishDirectory = publish;
  }
  if (Object.keys(methodSettings).length > 0)
    build.methodSettings = methodSettings;

  const root = buildPathFor(app);
  if (root) build.rootDirectory = root;

  // The panel's own overrides of the build steps, where it has them.
  if (app.installCommand?.trim())
    build.installCommand = app.installCommand.trim();
  if (app.buildCommand?.trim()) build.buildCommand = app.buildCommand.trim();

  // Dokploy's `command` overrides the container's command; Deplo's closest field
  // is the builder's start command. Same intent, different layer for a
  // Dockerfile build (where Deplo leaves CMD alone), hence the note. An app run
  // straight from an image has no build for the field to reach, so it is said.
  const command = app.command?.trim();
  if (command && app.sourceType === "docker") {
    notes.push(
      `Ran with the command "${truncate(command, 80)}" on {panel}. Deplo runs the image's own command; set it in the image or turn the app into a compose stack to keep it.`,
    );
  } else if (command) {
    build.startCommand = command;
    if (buildMethod === "dockerfile")
      notes.push(
        `Container command "${truncate(command, 80)}" became the start command. A Dockerfile keeps its own CMD.`,
      );
  }

  if ((app.replicas ?? 1) > 1)
    notes.push(
      `Runs ${app.replicas} replicas on {panel}. Deplo runs one container per app, so it arrives as one.`,
    );

  return { value: build, notes };
}

/** The repo subdirectory to build from, whichever provider the app uses. */
function buildPathFor(app: SourceApplication | SourceCompose): string | null {
  const candidates = [
    (app as SourceApplication).buildPath,
    (app as SourceApplication).gitlabBuildPath,
    (app as SourceApplication).giteaBuildPath,
    (app as SourceApplication).bitbucketBuildPath,
    (app as SourceApplication).customGitBuildPath,
  ];
  for (const c of candidates) {
    const v = c?.trim();
    if (v && v !== "/" && v !== "./") return v;
  }
  return null;
}

const MEM_UNITS: Record<string, number> = {
  b: 1 / (1024 * 1024),
  k: 1 / 1024,
  kb: 1 / 1024,
  ki: 1 / 1024,
  kib: 1 / 1024,
  m: 1,
  mb: 1,
  mi: 1,
  mib: 1,
  g: 1024,
  gb: 1024,
  gi: 1024,
  gib: 1024,
};

/** Docker's memory grammar (`512m`, `1g`, `1.5Gi`, or a bare byte count) → MiB. */
export function parseMemoryMb(raw: string | null | undefined): number | null {
  const s = raw?.trim().toLowerCase();
  if (!s) return null;
  const m = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2];
  // A bare number in this column is bytes, which is what Docker's API takes and
  // what Dokploy's own forms sometimes hold.
  const factor = unit ? MEM_UNITS[unit] : 1 / (1024 * 1024);
  if (factor === undefined) return null;
  const mb = Math.round(n * factor);
  return mb >= 1 ? mb : null;
}

/**
 * Dokploy's CPU limit → Deplo's milli-CPUs.
 *
 * ponytail: the column is free text and holds two conventions - cores as a
 * decimal and nano-CPUs. Split on 1000; a third convention changes this line.
 */
export function parseCpuMilli(raw: string | null | undefined): number | null {
  const s = raw?.trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  const milli = n > 1000 ? Math.round(n / 1_000_000) : Math.round(n * 1000);
  return milli >= 10 ? milli : null;
}

/**
 * `0` in any of Docker's limit flags means NO limit, and it is what one panel
 * writes in every column of every app. Read as an unparsable value it produced
 * three false alarms per application, which is how a real one goes unread.
 */
const NO_LIMIT = /^0+(\.0+)?\s*[a-z]*$/i;

function isNoLimit(raw: string | null | undefined): boolean {
  return NO_LIMIT.test((raw ?? "").trim());
}

/** Dokploy's four limit columns → Deplo's `resource_*`. Null when nothing was set. */
export function mapResources(row: {
  memoryLimit?: string | null;
  memoryReservation?: string | null;
  cpuLimit?: string | null;
  cpuReservation?: string | null;
}): Mapped<ResourceInput | null> {
  const notes: string[] = [];
  const memoryMb = parseMemoryMb(row.memoryLimit);
  const memoryReservationMb = parseMemoryMb(row.memoryReservation);
  const cpuMilli = parseCpuMilli(row.cpuLimit);

  for (const [label, raw, parsed] of [
    ["Memory limit", row.memoryLimit, memoryMb],
    ["Memory reservation", row.memoryReservation, memoryReservationMb],
    ["CPU limit", row.cpuLimit, cpuMilli],
  ] as const)
    if (raw?.trim() && parsed == null && !isNoLimit(raw))
      notes.push(
        `${label} "${raw.trim()}" is not a value Deplo can read - set it by hand.`,
      );

  // Dokploy's cpuReservation is a swarm scheduling hint with no Deplo column.
  if (row.cpuReservation?.trim() && !isNoLimit(row.cpuReservation))
    notes.push(
      `CPU reservation "${row.cpuReservation.trim()}" is a Swarm placement hint. Deplo has no equivalent, so it is not imported.`,
    );

  // A reservation above the limit is what Deplo's own validator refuses; drop it
  // rather than lose the limit too.
  const reservation =
    memoryReservationMb != null &&
    memoryMb != null &&
    memoryReservationMb > memoryMb
      ? null
      : memoryReservationMb;
  if (reservation !== memoryReservationMb)
    notes.push(
      "Memory reservation is above the limit on {panel} - not imported.",
    );

  if (memoryMb == null && reservation == null && cpuMilli == null)
    return { value: null, notes };
  return {
    value: { memoryMb, memoryReservationMb: reservation, cpuMilli },
    notes,
  };
}

/**
 * The service's icon, carried over as-is. Those come back `null` rather than
 * throwing: an icon is decoration, and losing it must never be the reason a
 * service fails to import.
 */
export function mapLogo(icon: string | null | undefined): string | null {
  const value = icon?.trim();
  if (!value) return null;
  return isValidLogoValue(value) ? value : null;
}

/** Published host ports on an application, which Deplo does not do for apps. */
export function mapPorts(app: SourceApplication): Mapped<PublishedPort[]> {
  const notes: string[] = [];
  const value: PublishedPort[] = [];
  const seen = new Set<string>();
  for (const p of app.ports ?? []) {
    const published = Number(p.publishedPort);
    const target = Number(p.targetPort);
    const protocol = `${p.protocol ?? "tcp"}`.toLowerCase().startsWith("udp")
      ? "udp"
      : "tcp";
    const spec = `${p.publishedPort}->${p.targetPort}/${protocol}`;
    if (!isValidExposePort(published) || !Number.isInteger(target)) {
      // A privileged port belongs to the host, and 80/443 belong to the proxy.
      notes.push(
        `${spec} on {panel} is not a port Deplo can publish (${MIN_USER_PORT}-${MAX_PORT}) - add a domain instead, or publish it on a higher port under Settings -> Advanced.`,
      );
      continue;
    }
    const key = `${published}/${protocol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    value.push({ id: "", published, target, protocol });
  }
  return { value, notes };
}

/**
 * Dokploy keeps a health check in Swarm's own shape - `Test`, durations in
 * nanoseconds - and every field of it has a column here, so it comes across
 * instead of being reported as a setting with no equivalent.
 */
export function swarmHealthCheck(spec: unknown): HealthCheck | null {
  if (!spec || typeof spec !== "object") return null;
  const row = spec as Record<string, unknown>;
  const at = (key: string): unknown =>
    row[key] ?? row[key[0].toLowerCase() + key.slice(1)];
  const test = Array.isArray(at("Test"))
    ? (at("Test") as unknown[]).map(String)
    : [];
  if (test.length === 0 || test[0] === "NONE") return null;
  const command = (
    test[0] === "CMD" || test[0] === "CMD-SHELL" ? test.slice(1) : test
  )
    .join(" ")
    .trim();
  if (!command) return null;
  const seconds = (key: string, fallback: number): number => {
    const n = Number(at(key));
    return Number.isFinite(n) && n > 0
      ? Math.max(1, Math.round(n / 1e9))
      : fallback;
  };
  const intervalS = seconds("Interval", HEALTH_CHECK_DEFAULTS.intervalS);
  const timeoutS = seconds("Timeout", HEALTH_CHECK_DEFAULTS.timeoutS);
  const retries = Number(at("Retries"));
  return {
    type: "command",
    path: null,
    port: null,
    command,
    intervalS,
    // Deplo refuses a check still running when the next one is due.
    timeoutS: timeoutS < intervalS ? timeoutS : Math.max(1, intervalS - 1),
    retries:
      Number.isFinite(retries) && retries > 0
        ? Math.round(retries)
        : HEALTH_CHECK_DEFAULTS.retries,
    startPeriodS: seconds("StartPeriod", HEALTH_CHECK_DEFAULTS.startPeriodS),
  };
}

/** Everything else on a Dokploy service with no Deplo column at all. */
export function unsupportedNotes(app: SourceApplication): string[] {
  const notes: string[] = [];
  if ((app.redirects ?? []).length > 0)
    notes.push(
      `${app.redirects!.length} redirect rule(s) on {panel} - Deplo has no redirect list, use a domain per host.`,
    );
  // Swarm's own service spec.
  const swarm = (
    [
      ["healthCheckSwarm", "a health check"],
      ["placementSwarm", "placement constraints"],
      ["labelsSwarm", "service labels"],
      ["ulimitsSwarm", "ulimits"],
    ] as const
  ).filter(
    ([key]) =>
      hasSwarmValue(app[key]) &&
      // The health check is imported now, so it is not a loss to report.
      !(key === "healthCheckSwarm" && swarmHealthCheck(app[key])),
  );
  if (swarm.length > 0)
    notes.push(
      `Swarm settings on {panel} (${swarm.map(([, label]) => label).join(", ")}) have no equivalent here - Deplo runs one container per app through compose.`,
    );
  return notes;
}

/** A swarm column Dokploy actually filled in (it stores `null` or `{}` otherwise). */
function hasSwarmValue(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "string") return v.trim() !== "" && v.trim() !== "{}";
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return false;
}
