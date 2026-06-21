import "server-only";

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import {
  caCertPem,
  issueAgentServerCert,
  type CertBundle,
} from "./pki";

/**
 * The LOCAL agent supervisor (PLAN Part A). In Part A every server resolves to
 * an agent running on the Deplo host itself: "localhost" and "remote" become a
 * transport detail (Decision 4), and the local agent is the first instance of
 * that uniform path. This module owns that local process — it mints the agent's
 * mTLS materials from the control plane's CA, launches the `deplo-agent` binary,
 * and hands the dial address + the control plane's own client cert to the
 * agent-client. Remote provisioning (call-home bootstrap) is Part B; here the
 * agent is a child process of the control plane, supervised in-process.
 *
 * The binary path is `DEPLO_AGENT_BIN` (the Dockerfile builds it into the image;
 * in dev, build it with `make -C agent build` or point the env var at the
 * `go build` output). If the binary is absent, {@link ensureLocalAgent} throws a
 * clear error and the caller falls back to the in-process deploy path — so a
 * tree without a built agent still deploys exactly as before.
 */

const DATA_DIR = process.env.DEPLO_DATA_DIR || "/data";
const AGENT_DIR = join(DATA_DIR, "agent");
const AGENT_ADDR = process.env.DEPLO_AGENT_ADDR || "127.0.0.1:9443";
const AGENT_HOST = AGENT_ADDR.split(":")[0] || "127.0.0.1";

/** Everything the agent-client needs to dial the local agent over mTLS. */
export interface LocalAgentHandle {
  /** host:port to dial. */
  address: string;
  /** TLS server name to verify against the agent cert's SANs. */
  serverName: string;
  /** The control plane's client cert/key + the pinned CA, for the dial. */
  clientCreds: { certPem: string; keyPem: string; caPem: string };
}

interface SupervisorState {
  proc: ChildProcess | null;
  handle: LocalAgentHandle | null;
  starting: Promise<LocalAgentHandle> | null;
}

// Process-global singleton (the control plane is a single process for the whole
// A-D arc, D8) — one supervised agent, reused across deploys. Pinned on
// globalThis via a Symbol so Next's split RSC / route-handler module registries
// share ONE supervisor (the same reason lib/store.ts pins its cache there).
const SUPERVISOR_KEY = Symbol.for("deplo.localAgent.supervisor");
const g = globalThis as unknown as { [SUPERVISOR_KEY]?: SupervisorState };
const state: SupervisorState = (g[SUPERVISOR_KEY] ??= {
  proc: null,
  handle: null,
  starting: null,
});

function agentBinPath(): string | null {
  return process.env.DEPLO_AGENT_BIN || null;
}

/**
 * Ensure the local agent is running and return a handle to dial it. Idempotent:
 * a healthy running agent is reused; a never-started one is provisioned and
 * launched. Concurrent callers share one start. Throws if the binary is not
 * configured/present (the caller treats that as "agent unavailable" and uses the
 * legacy path).
 */
export async function ensureLocalAgent(
  helloProbe: (h: LocalAgentHandle) => Promise<boolean>,
): Promise<LocalAgentHandle> {
  if (state.handle && state.proc && state.proc.exitCode === null) {
    return state.handle;
  }
  if (state.starting) return state.starting;

  state.starting = (async () => {
    const bin = agentBinPath();
    if (!bin) {
      throw new Error(
        "DEPLO_AGENT_BIN is not set — the local agent binary is unavailable; " +
          "falling back to the in-process deploy path.",
      );
    }

    // Reuse a still-running agent (it outlives a control-plane restart; the same
    // derived CA means our freshly-minted client cert still authenticates). This
    // also avoids a "bind: address already in use" when the previous agent is
    // alive — a restart RECONNECTS rather than spawning a duplicate.
    const reuse: LocalAgentHandle = {
      address: AGENT_ADDR,
      serverName: "localhost",
      clientCreds: await issueClientCreds(),
    };
    if (await helloProbe(reuse).catch(() => false)) {
      state.proc = null; // not ours to supervise, but it is reachable
      state.handle = reuse;
      return reuse;
    }

    // Mint the agent's server cert (SANs cover localhost/127.0.0.1 + the dial
    // host) and the control plane's client cert, both from the derived CA.
    const server = await issueAgentServerCert([AGENT_HOST]);
    const ca = await caCertPem();
    await writeAgentMaterials(server, ca);

    const proc = spawn(
      bin,
      [
        "--addr",
        AGENT_ADDR,
        "--cert",
        join(AGENT_DIR, "agent.crt"),
        "--key",
        join(AGENT_DIR, "agent.key"),
        "--ca",
        join(AGENT_DIR, "ca.crt"),
        // Explicitly require mTLS, defeating any inherited DEPLO_AGENT_INSECURE=1
        // in the control plane's env (which the agent reads as the flag default).
        // The supervised local agent must NEVER serve without mTLS.
        "--insecure=false",
        "--stack-dir",
        join(DATA_DIR, "stacks"),
        "--data-dir",
        DATA_DIR,
      ],
      {
        stdio: ["ignore", "inherit", "inherit"],
        // The agent shares the control plane's docker socket access; it inherits
        // the environment (DOCKER_HOST etc. unset => the local socket).
        env: process.env,
      },
    );
    state.proc = proc;
    proc.on("exit", (code) => {
      console.warn(`[deplo] local agent exited (code ${code})`);
      if (state.proc === proc) {
        state.proc = null;
        state.handle = null;
      }
    });

    const handle: LocalAgentHandle = {
      address: AGENT_ADDR,
      serverName: "localhost",
      clientCreds: await issueClientCreds(),
    };

    // Wait for the agent to answer Hello (it is listening within a few ms, but
    // give it a generous window for a cold start). A failed probe means the
    // agent couldn't come up — surface it so the caller falls back.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) {
        throw new Error("local agent exited before becoming reachable");
      }
      if (await helloProbe(handle).catch(() => false)) {
        state.handle = handle;
        return handle;
      }
      await sleep(300);
    }
    proc.kill("SIGKILL");
    throw new Error("local agent did not become reachable within 15s");
  })();

  try {
    return await state.starting;
  } finally {
    state.starting = null;
  }
}

/** The control plane's client cert/key + pinned CA, minted fresh per start. */
async function issueClientCreds(): Promise<{
  certPem: string;
  keyPem: string;
  caPem: string;
}> {
  const { issueControlPlaneClientCert } = await import("./pki");
  const c = await issueControlPlaneClientCert();
  return { certPem: c.certPem, keyPem: c.keyPem, caPem: c.caPem };
}

async function writeAgentMaterials(
  server: CertBundle,
  caPem: string,
): Promise<void> {
  await mkdir(AGENT_DIR, { recursive: true, mode: 0o700 });
  await writeFile(join(AGENT_DIR, "agent.crt"), server.certPem, { mode: 0o600 });
  await writeFile(join(AGENT_DIR, "agent.key"), server.keyPem, { mode: 0o600 });
  await writeFile(join(AGENT_DIR, "ca.crt"), caPem, { mode: 0o644 });
  await chmod(AGENT_DIR, 0o700).catch(() => {});
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
