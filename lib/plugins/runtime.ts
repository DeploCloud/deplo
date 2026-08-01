import "server-only";

/**
 * Plugin runtime — the host-container lifecycle for installed plugins (ADR-0005).
 *
 * **DORMANT (ADR-0013).** The Plugins feature is deferred: there is no UI, no
 * GraphQL surface and no catalog client, so nothing installs a plugin today. The
 * live callers are the retirement sweep (`./retire`) and team/user deletion,
 * which both only need to TEAR DOWN a container left by an older version. The
 * module is kept whole — naming, render, lifecycle — as the foundation the
 * feature returns on; read ADR-0013 before reviving it, because the return is
 * expected to route through the **server agent** (ADR-0006) rather than the
 * control plane's own socket, which is what the code below still does.
 *
 * This is a host-managed singleton (the pattern the retired SSH gateway
 * pioneered) applied to
 * plugins, NOT the app pipeline: Deplo renders a tiny compose for the plugin's
 * image, brings it up on the `deplo` network directly via the docker socket,
 * and reads live status with `docker inspect`. A plugin is labelled
 * `deplo.managed=true` + `deplo.role=app` and reached on the **plugin path** under
 * Deplo's own host (a Traefik `PathPrefix` router + `stripprefix`), reusing
 * Deplo's TLS — never a per-plugin domain/sslip.io/cert. The `deplo-app-<slug>`
 * container name and `deplo.role=app` label are the FROZEN physical identity
 * (ADR-0005's pre-rename vocabulary) — every existing install answers to them, so
 * they must not be "modernised" or the sweep and teardown stop finding anything.
 *
 * Router priority: the plugin's `Host(deplo) && PathPrefix(/plugins/<slug>)` router
 * wins over the dashboard's bare `Host(deplo)` router because the dashboard
 * router is pinned to `priority=1` (docker-compose.yml / install.sh) — Traefik
 * otherwise defaults an un-pinned router's priority to its rule-string length,
 * which for a real host would exceed a short PathPrefix's length and shadow the
 * app path. The pin makes the dashboard a true fallback that every path router
 * beats.
 *
 * The render is pure (image + env in, YAML out); the lifecycle ops shell out
 * through the shared `docker()` helper and address the stack by an absolute
 * `-f <file>` path with a deterministic compose project name, exactly like
 * `startContainer`/`stopContainer`/`destroyStack` in `lib/deploy/build.ts`.
 */

import { mkdir, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { docker, ensureNetwork } from "../infra/docker";
import { certResolver } from "../deploy/domains";
import { traefikRouterLabels } from "../deploy/routing";
import { resolvePublicBaseUrl } from "../public-url";
import type { PluginManifest } from "./manifest";

/** The shared external network every routed runtime joins. */
const NETWORK = "deplo";

/** Plugin stacks live under their own dir under the data root (the `apps`
 *  directory name is part of the frozen on-disk identity — see the header). */
const DATA_DIR = process.env.DEPLO_DATA_DIR || "/data";
const APPS_DIR = join(DATA_DIR, "apps");

/* ------------------------------------------------------------------ */
/* Naming — deterministic per (plugin, team)                          */
/* ------------------------------------------------------------------ */

/**
 * The plugin slug — the stable, per-team identity that seeds the container name,
 * the compose project, the stack file, and the plugin path. Joined with `__`
 * (NOT a single `-`): both halves are `[a-z0-9-]` (catalogId by the manifest
 * regex, teamSlug by the team slugifier), so `__` can never appear inside
 * either half — making the (catalogId, teamSlug) → slug mapping INJECTIVE. A
 * single `-` is not injective (`relay`+`acme-x` and `relay-acme`+`x` would collide
 * on one container/path router); the `__` convention mirrors `lib/deploy/
 * routing.ts`, which uses it for exactly this reason. `__` is a valid char in
 * a docker container/compose name and a URL path, so every consumer is safe.
 */
export function pluginSlug(catalogId: string, teamSlug: string): string {
  return `${catalogId}__${teamSlug}`;
}

/** The container name for a plugin slug — deterministic, so status is a lookup. */
export function pluginContainerName(slug: string): string {
  return `deplo-app-${slug}`;
}

/** The compose project name (mirrors `deplo-<slug>` for app stacks). */
function pluginService(slug: string): string {
  return `deplo-app-${slug}`;
}

/** The plugin path under Deplo's own host, e.g. `/plugins/relay__acme`. */
export function pluginPathPrefix(slug: string): string {
  return `/plugins/${slug}`;
}

/** Absolute path of a plugin's rendered compose file. */
function pluginStackFile(slug: string): string {
  return join(APPS_DIR, `${slug}.yml`);
}

/* ------------------------------------------------------------------ */
/* Pure render                                                         */
/* ------------------------------------------------------------------ */

/**
 * Render a plugin's docker-compose — PURE (image + resolved env in, YAML out).
 * One service:
 *   - the manifest `image`, named `deplo-app-<slug>`, `restart: unless-stopped`
 *   - joined to the external `deplo` network
 *   - labelled `deplo.managed=true` + `deplo.role=app` (the only containers that
 *     carry `deplo.role=app`; production stacks carry no role)
 *   - Traefik path labels (built by `traefikRouterLabels`) for
 *     `Host(<deplo>) && PathPrefix(/plugins/<slug>)` + `stripprefix`, forwarding to
 *     the manifest's `expose.port`. This router outranks the dashboard's bare
 *     `Host(DEPLO_DOMAIN)` router because that one is pinned to `priority=1`
 *     (see the module header), so the plugin path is never shadowed.
 *
 * `resolvedEnv` is the manifest env with placeholders already substituted
 * (`resolvePluginEnv` in `./manifest`). `deploHost` is Deplo's own hostname (no
 * scheme) for the Traefik `Host()` rule.
 */
export function renderPluginCompose(args: {
  slug: string;
  image: string;
  port: number;
  deploHost: string;
  resolvedEnv: Record<string, string>;
}): string {
  const { slug, image, port, deploHost, resolvedEnv } = args;
  const labels = traefikRouterLabels({
    baseKey: pluginService(slug),
    routes: [
      { name: deploHost, port, pathPrefix: pluginPathPrefix(slug), stripPrefix: true },
    ],
    defaultPort: port,
    certResolver: certResolver(),
    dockerNetwork: NETWORK,
    // Force the explicit `.service` label even for a single router (compose/dev
    // do the same), so the plugin's router binding is unambiguous.
    alwaysService: true,
  });

  const envLines = Object.entries(resolvedEnv)
    .map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`)
    .join("\n");

  return `# Generated by Deplo — app ${slug} (ADR-0005: host-managed container, not a project)
services:
  app:
    image: ${JSON.stringify(image)}
    container_name: ${pluginContainerName(slug)}
    restart: unless-stopped
${envLines ? `    environment:\n${envLines}\n` : ""}    networks:
      - ${NETWORK}
    labels:
      - "deplo.managed=true"
      - "deplo.role=app"
${labels.map((l) => `      - ${JSON.stringify(l)}`).join("\n")}

networks:
  ${NETWORK}:
    external: true
`;
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

/** Resolve Deplo's own hostname (no scheme) for the Traefik `Host()` rule. */
function deploHost(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
}

/**
 * Write the rendered compose and bring the plugin container up on the `deplo`
 * network. Idempotent: re-running with a changed manifest recreates the
 * container in place (`up -d` reconciles). Used by both install and a re-install
 * "recreate" (one plugin per team — no duplicate row).
 *
 * On a FRESH install (`isReinstall` false) a failed `up` — e.g. the image can't
 * be pulled — is rolled back: the partial compose project is torn down and the
 * stack file removed, so a failed install leaves NO residue (no orphan
 * `<slug>.yml`, no half-created container/router). On a reinstall the existing
 * container must survive a failed pull, so the file is left in place.
 */
export async function startPluginStack(args: {
  slug: string;
  manifest: PluginManifest;
  resolvedEnv: Record<string, string>;
  publicBaseUrl: string;
  /** True when recreating an already-installed plugin (keep residue on failure). */
  isReinstall?: boolean;
}): Promise<void> {
  const { slug, manifest, resolvedEnv, publicBaseUrl, isReinstall } = args;
  await ensureNetwork(NETWORK);
  await mkdir(APPS_DIR, { recursive: true });
  const stackFile = pluginStackFile(slug);
  await writeFile(
    stackFile,
    renderPluginCompose({
      slug,
      image: manifest.image,
      port: manifest.expose.port,
      deploHost: deploHost(publicBaseUrl),
      resolvedEnv,
    }),
  );
  try {
    await docker(
      ["compose", "-p", pluginService(slug), "-f", stackFile, "up", "-d", "--remove-orphans"],
      { timeout: 180_000 },
    );
  } catch (err) {
    if (!isReinstall) {
      // Roll back a fresh install so a failed pull/up leaves nothing behind.
      await docker(
        ["compose", "-p", pluginService(slug), "-f", stackFile, "down", "--remove-orphans"],
        { timeout: 60_000, noThrow: true },
      ).catch(() => {});
      await rm(stackFile, { force: true }).catch(() => {});
    }
    throw err;
  }
}

/** Start a stopped plugin container (compose start, falling back to the container). */
export async function startPluginContainer(slug: string): Promise<void> {
  const stackFile = pluginStackFile(slug);
  if (await fileExists(stackFile)) {
    await docker(["compose", "-p", pluginService(slug), "-f", stackFile, "start"], {
      timeout: 60_000,
    });
  } else {
    await docker(["start", pluginContainerName(slug)], { timeout: 30_000 });
  }
}

/** Stop a running plugin container (compose stop, falling back to the container). */
export async function stopPluginContainer(slug: string): Promise<void> {
  const stackFile = pluginStackFile(slug);
  if (await fileExists(stackFile)) {
    await docker(["compose", "-p", pluginService(slug), "-f", stackFile, "stop"], {
      timeout: 60_000,
    });
  } else {
    await docker(["stop", pluginContainerName(slug)], { timeout: 30_000 });
  }
}

/**
 * Live status of a plugin container, read at query time (never stored). Reports
 * three states:
 *   - "running"  — the container exists and `.State.Running == true`
 *   - "stopped"  — the container exists but is not running
 *   - "error"    — no container / daemon unreachable (the truth, not a guess)
 */
export async function pluginStatus(
  slug: string,
): Promise<"running" | "stopped" | "error"> {
  try {
    const { stdout, code } = await docker(
      ["inspect", "-f", "{{.State.Running}}", pluginContainerName(slug)],
      { timeout: 10_000, noThrow: true },
    );
    if (code !== 0) return "error"; // no such container
    return stdout.trim() === "true" ? "running" : "stopped";
  } catch {
    return "error"; // daemon unreachable
  }
}

/**
 * Tear the plugin container down and remove its stack file, so uninstall leaves no
 * orphaned Traefik router (the path router lives in the compose labels). Mirrors
 * `destroyStack`: `compose down --remove-orphans`, falling back to a force-rm,
 * then deletes the rendered compose. Best-effort — a missing container/file is
 * not an error (uninstall must always succeed in dropping the row).
 */
export async function destroyPluginContainer(slug: string): Promise<void> {
  const stackFile = pluginStackFile(slug);
  if (await fileExists(stackFile)) {
    await docker(
      ["compose", "-p", pluginService(slug), "-f", stackFile, "down", "--remove-orphans"],
      { timeout: 120_000, noThrow: true },
    ).catch(() => {});
  } else {
    await docker(["rm", "-f", pluginContainerName(slug)], {
      timeout: 30_000,
      noThrow: true,
    }).catch(() => {});
  }
  await rm(stackFile, { force: true }).catch(() => {});
}

/** Compute a plugin's full plugin-path URL from the public base URL + slug. */
export function pluginUrl(publicBaseUrl: string, slug: string): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}${pluginPathPrefix(slug)}`;
}

/* ------------------------------------------------------------------ */
/* internals                                                          */
/* ------------------------------------------------------------------ */

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// `resolvePublicBaseUrl` is re-exported for the (future) data layer's convenience
// so the install flow has one import for the URL it bakes into both the container
// env and the plugin path it returns.
export { resolvePublicBaseUrl };
