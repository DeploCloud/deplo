import "server-only";

import { mkdir, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { read } from "../store";
import { decryptSecret } from "../crypto";
import { docker, ensureNetwork } from "./docker";
import { dataVolumeHostMountpoint } from "../deploy/builders";
import {
  GATEWAY_PROJECT,
  GATEWAY_CONTAINER,
  GATEWAY_PORT,
  WRAPPER_SCRIPT,
  SSHD_CONFIG,
  GATEWAY_ENTRYPOINT,
  SOCKET_FILTER_CFG,
  renderGatewayCompose,
} from "./gateway-config";
import {
  provisionSteps,
  deprovisionSteps,
  type GatewayStep,
  type GatewayTarget,
} from "./gateway-projection";
import type { DevSshUser } from "../types";

// Re-export the identity constants so existing callers keep importing them here.
export { GATEWAY_PROJECT, GATEWAY_CONTAINER, GATEWAY_PORT };

const DATA_DIR = process.env.DEPLO_DATA_DIR || "/data";
/** All gateway-managed files live here (host keys, sshd_config, wrapper, maps). */
const GW_DIR = join(DATA_DIR, "ssh-gateway");
const GW_STACK_FILE = join(GW_DIR, "docker-compose.yml");

// ---------------------------------------------------------------------------
// File materialisation — write the pure-rendered configs to the bind mount.
// ---------------------------------------------------------------------------

/** Write all gateway-managed config files (idempotent). The contents are
 * rendered by the pure ./gateway-config module; this just lands them on disk
 * (host-path-translated so the bind mount works in Postgres/volume mode). */
async function writeGatewayFiles(): Promise<void> {
  await mkdir(join(GW_DIR, "keys"), { recursive: true });
  await mkdir(join(GW_DIR, "map"), { recursive: true });

  const mountpoint = await dataVolumeHostMountpoint();
  const gwHostDir =
    mountpoint && GW_DIR.startsWith(DATA_DIR)
      ? join(mountpoint, GW_DIR.slice(DATA_DIR.length))
      : GW_DIR;

  await writeFile(GW_STACK_FILE, renderGatewayCompose(gwHostDir));
  await writeFile(join(GW_DIR, "socket-filter.cfg"), SOCKET_FILTER_CFG);
  await writeFile(join(GW_DIR, "sshd_config"), SSHD_CONFIG);
  await writeFile(join(GW_DIR, "deplo-dev-shell"), WRAPPER_SCRIPT, { mode: 0o755 });
  await chmod(join(GW_DIR, "deplo-dev-shell"), 0o755).catch(() => {});
  await writeFile(join(GW_DIR, "gateway-entrypoint"), GATEWAY_ENTRYPOINT, {
    mode: 0o755,
  });
  await chmod(join(GW_DIR, "gateway-entrypoint"), 0o755).catch(() => {});
}

// ---------------------------------------------------------------------------
// Lifecycle — create, wait, reconcile (ADR-0002: lazy platform infrastructure).
// ---------------------------------------------------------------------------

/** Is the gateway container currently running? */
async function gatewayRunning(): Promise<boolean> {
  try {
    const { stdout } = await docker(
      ["inspect", "-f", "{{.State.Running}}", GATEWAY_CONTAINER],
      { timeout: 10_000, noThrow: true },
    );
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Lazily create the gateway on the first SSH user (ADR-0002) — never at install.
 * Idempotent, like ensureNetwork: writes config, brings the 2-service stack up,
 * then reconciles every stored DevSshUser into the fresh container. Safe to call
 * on every startDev / addDevSshUser.
 */
export async function ensureGateway(): Promise<void> {
  await ensureNetwork("deplo");
  await writeGatewayFiles();
  await docker(
    ["compose", "-p", GATEWAY_PROJECT, "-f", GW_STACK_FILE, "up", "-d", "--remove-orphans"],
    { timeout: 180_000 },
  );
  await waitGatewayReady(60_000);
  await reconcileGateway();
}

/** Poll until sshd is up inside the gateway (the entrypoint installs it). */
async function waitGatewayReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await docker(
        ["exec", GATEWAY_CONTAINER, "sh", "-c", "command -v sshd >/dev/null && echo ok"],
        { timeout: 10_000, noThrow: true },
      );
      if (stdout.trim() === "ok") return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// ---------------------------------------------------------------------------
// Per-user provisioning — store leads, gateway exec follows. No sshd reload.
// The PLAN (which exec steps) is computed by the pure ./gateway-projection
// module; this driver just decrypts the password and runs the steps.
// ---------------------------------------------------------------------------

/** Look up the dev container name for a user's project (for the map file). */
function devContainerForProject(projectId: string): GatewayTarget | null {
  const p = read().projects.find((x) => x.id === projectId);
  if (!p) return null;
  return { slug: p.slug, container: `deplo-dev-${p.slug}` };
}

/** Run one projected step inside the gateway container. */
function runStep(step: GatewayStep) {
  return docker(["exec", "-i", GATEWAY_CONTAINER, ...step.argv], {
    timeout: 30_000,
    input: step.input,
    noThrow: true,
  });
}

/**
 * Provision one user inside the running gateway (no sshd reload — sshd reads
 * accounts/keys/maps per-connection). Decrypts the password just-in-time and
 * hands the cleartext to the pure projection, which never sees ciphertext; the
 * secret is passed to chpasswd over STDIN, never argv/env that `docker inspect`
 * could surface.
 */
export async function provisionUser(user: DevSshUser): Promise<void> {
  const target = devContainerForProject(user.projectId);
  if (!target) return;
  const steps = provisionSteps(
    {
      username: user.username,
      password: user.passwordEnc ? decryptSecret(user.passwordEnc) : null,
      publicKey: user.publicKey ?? null,
    },
    target,
  );
  for (const step of steps) await runStep(step);
}

/** Remove one user from the gateway (account + key + map files). */
export async function deprovisionUser(username: string): Promise<void> {
  if (!(await gatewayRunning())) return;
  for (const step of deprovisionSteps(username)) await runStep(step);
}

/**
 * Rebuild the gateway's account/key/map projection from the store (the sole
 * source of truth — ADR-0002). Called on gateway first boot and after drift.
 * The store always leads; a reconcile after any mutation is always correct.
 */
export async function reconcileGateway(): Promise<void> {
  if (!(await gatewayRunning())) return;
  const users = read().devSshUsers;
  for (const u of users) {
    await provisionUser(u).catch(() => {});
  }
}
