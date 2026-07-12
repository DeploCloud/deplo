import "server-only";

/**
 * App runtime — the host-container lifecycle for installed apps (ADR-0005).
 *
 * This is the SSH-gateway precedent (`lib/infra/ssh-gateway.ts`) applied to
 * apps, NOT the project pipeline: Deplo renders a tiny compose for the app's
 * image, brings it up on the `deplo` network directly via the docker socket,
 * and reads live status with `docker inspect`. An app is labelled
 * `deplo.managed=true` + `deplo.role=app` and reached on the **app path** under
 * Deplo's own host (a Traefik `PathPrefix` router + `stripprefix`), reusing
 * Deplo's TLS — never a per-app domain/nip.io/cert.
 *
 * Router priority: the app's `Host(deplo) && PathPrefix(/apps/<slug>)` router
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
import type { AppManifest } from "./manifest";

/** The shared external network every routed runtime joins. */
const NETWORK = "deplo";

/** App stacks live under their own dir, like the gateway has `ssh-gateway/`. */
const DATA_DIR = process.env.DEPLO_DATA_DIR || "/data";
const APPS_DIR = join(DATA_DIR, "apps");

/* ------------------------------------------------------------------ */
/* Naming — deterministic per (app, team)                             */
/* ------------------------------------------------------------------ */

/**
 * The app slug — the stable, per-team identity that seeds the container name,
 * the compose project, the stack file, and the app path. Joined with `__`
 * (NOT a single `-`): both halves are `[a-z0-9-]` (catalogId by the manifest
 * regex, teamSlug by the team slugifier), so `__` can never appear inside
 * either half — making the (catalogId, teamSlug) → slug mapping INJECTIVE. A
 * single `-` is not injective (`mcp`+`acme-x` and `mcp-acme`+`x` would collide
 * on one container/path router); the `__` convention mirrors `lib/deploy/
 * routing.ts`, which uses it for exactly this reason. `__` is a valid char in
 * a docker container/compose name and a URL path, so every consumer is safe.
 */
export function appSlug(catalogId: string, teamSlug: string): string {
  return `${catalogId}__${teamSlug}`;
}

/** The container name for an app slug — deterministic, so status is a lookup. */
export function appContainerName(slug: string): string {
  return `deplo-app-${slug}`;
}

/** The compose project name (mirrors `deplo-<slug>` for project stacks). */
function appService(slug: string): string {
  return `deplo-app-${slug}`;
}

/** The app path under Deplo's own host, e.g. `/apps/mcp-acme`. */
export function appPathPrefix(slug: string): string {
  return `/apps/${slug}`;
}

/** Absolute path of an app's rendered compose file. */
function appStackFile(slug: string): string {
  return join(APPS_DIR, `${slug}.yml`);
}

/* ------------------------------------------------------------------ */
/* Pure render                                                         */
/* ------------------------------------------------------------------ */

/**
 * Render an app's docker-compose — PURE (image + resolved env in, YAML out),
 * like `renderGatewayCompose`. One service:
 *   - the manifest `image`, named `deplo-app-<slug>`, `restart: unless-stopped`
 *   - joined to the external `deplo` network
 *   - labelled `deplo.managed=true` + `deplo.role=app` (the first containers to
 *     carry `deplo.role=app`; production stacks carry no role)
 *   - Traefik path labels (built by `traefikRouterLabels`) for
 *     `Host(<deplo>) && PathPrefix(/apps/<slug>)` + `stripprefix`, forwarding to
 *     the manifest's `expose.port`. This router outranks the dashboard's bare
 *     `Host(DEPLO_DOMAIN)` router because that one is pinned to `priority=1`
 *     (see the module header), so the app path is never shadowed.
 *
 * `resolvedEnv` is the manifest env with placeholders already substituted
 * (`resolveAppEnv` in `./manifest`) — for the MCP app, just `DEPLO_GRAPHQL_URL`.
 * `deploHost` is Deplo's own hostname (no scheme) for the Traefik `Host()` rule.
 */
export function renderAppCompose(args: {
  slug: string;
  image: string;
  port: number;
  deploHost: string;
  resolvedEnv: Record<string, string>;
}): string {
  const { slug, image, port, deploHost, resolvedEnv } = args;
  const labels = traefikRouterLabels({
    baseKey: appService(slug),
    routes: [
      { name: deploHost, port, pathPrefix: appPathPrefix(slug), stripPrefix: true },
    ],
    defaultPort: port,
    certResolver: certResolver(),
    dockerNetwork: NETWORK,
    // Force the explicit `.service` label even for a single router (compose/dev
    // do the same), so the app's router binding is unambiguous.
    alwaysService: true,
  });

  const envLines = Object.entries(resolvedEnv)
    .map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`)
    .join("\n");

  return `# Generated by Deplo — app ${slug} (ADR-0005: host-managed container, not a project)
services:
  app:
    image: ${JSON.stringify(image)}
    container_name: ${appContainerName(slug)}
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
 * Write the rendered compose and bring the app container up on the `deplo`
 * network. Idempotent: re-running with a changed manifest recreates the
 * container in place (`up -d` reconciles). Used by both install and a re-install
 * "recreate" (one app per team — no duplicate row).
 *
 * On a FRESH install (`isReinstall` false) a failed `up` — e.g. the image can't
 * be pulled — is rolled back: the partial compose project is torn down and the
 * stack file removed, so a failed install leaves NO residue (no orphan
 * `<slug>.yml`, no half-created container/router). On a reinstall the existing
 * container must survive a failed pull, so the file is left in place.
 */
export async function startAppStack(args: {
  slug: string;
  manifest: AppManifest;
  resolvedEnv: Record<string, string>;
  publicBaseUrl: string;
  /** True when recreating an already-installed app (keep residue on failure). */
  isReinstall?: boolean;
}): Promise<void> {
  const { slug, manifest, resolvedEnv, publicBaseUrl, isReinstall } = args;
  await ensureNetwork(NETWORK);
  await mkdir(APPS_DIR, { recursive: true });
  const stackFile = appStackFile(slug);
  await writeFile(
    stackFile,
    renderAppCompose({
      slug,
      image: manifest.image,
      port: manifest.expose.port,
      deploHost: deploHost(publicBaseUrl),
      resolvedEnv,
    }),
  );
  try {
    await docker(
      ["compose", "-p", appService(slug), "-f", stackFile, "up", "-d", "--remove-orphans"],
      { timeout: 180_000 },
    );
  } catch (err) {
    if (!isReinstall) {
      // Roll back a fresh install so a failed pull/up leaves nothing behind.
      await docker(
        ["compose", "-p", appService(slug), "-f", stackFile, "down", "--remove-orphans"],
        { timeout: 60_000, noThrow: true },
      ).catch(() => {});
      await rm(stackFile, { force: true }).catch(() => {});
    }
    throw err;
  }
}

/** Start a stopped app container (compose start, falling back to the container). */
export async function startAppContainer(slug: string): Promise<void> {
  const stackFile = appStackFile(slug);
  if (await fileExists(stackFile)) {
    await docker(["compose", "-p", appService(slug), "-f", stackFile, "start"], {
      timeout: 60_000,
    });
  } else {
    await docker(["start", appContainerName(slug)], { timeout: 30_000 });
  }
}

/** Stop a running app container (compose stop, falling back to the container). */
export async function stopAppContainer(slug: string): Promise<void> {
  const stackFile = appStackFile(slug);
  if (await fileExists(stackFile)) {
    await docker(["compose", "-p", appService(slug), "-f", stackFile, "stop"], {
      timeout: 60_000,
    });
  } else {
    await docker(["stop", appContainerName(slug)], { timeout: 30_000 });
  }
}

/**
 * Live status of an app container, read at query time (never stored). Mirrors
 * `gatewayRunning()` but reports the three states the UI shows:
 *   - "running"  — the container exists and `.State.Running == true`
 *   - "stopped"  — the container exists but is not running
 *   - "error"    — no container / daemon unreachable (the truth, not a guess)
 */
export async function appStatus(
  slug: string,
): Promise<"running" | "stopped" | "error"> {
  try {
    const { stdout, code } = await docker(
      ["inspect", "-f", "{{.State.Running}}", appContainerName(slug)],
      { timeout: 10_000, noThrow: true },
    );
    if (code !== 0) return "error"; // no such container
    return stdout.trim() === "true" ? "running" : "stopped";
  } catch {
    return "error"; // daemon unreachable
  }
}

/**
 * Tear the app container down and remove its stack file, so uninstall leaves no
 * orphaned Traefik router (the path router lives in the compose labels). Mirrors
 * `destroyStack`: `compose down --remove-orphans`, falling back to a force-rm,
 * then deletes the rendered compose. Best-effort — a missing container/file is
 * not an error (uninstall must always succeed in dropping the row).
 */
export async function destroyAppContainer(slug: string): Promise<void> {
  const stackFile = appStackFile(slug);
  if (await fileExists(stackFile)) {
    await docker(
      ["compose", "-p", appService(slug), "-f", stackFile, "down", "--remove-orphans"],
      { timeout: 120_000, noThrow: true },
    ).catch(() => {});
  } else {
    await docker(["rm", "-f", appContainerName(slug)], {
      timeout: 30_000,
      noThrow: true,
    }).catch(() => {});
  }
  await rm(stackFile, { force: true }).catch(() => {});
}

/** Compute an app's full app-path URL from the public base URL + slug. */
export function appUrl(publicBaseUrl: string, slug: string): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}${appPathPrefix(slug)}`;
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

// `resolvePublicBaseUrl` is re-exported for the data layer's convenience so the
// install flow has one import for the URL it bakes into both the container env
// and the app-path it returns.
export { resolvePublicBaseUrl };
