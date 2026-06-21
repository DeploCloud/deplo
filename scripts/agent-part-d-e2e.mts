/**
 * End-to-end smoke test for the server agent PART D (dev containers + SSH gateway
 * + VS Code tunnel + the DEV_WORKSPACE deploy source). Drives the REAL agent over
 * mTLS against real Docker, the way the control plane will: StartDev brings up a
 * dev container, StopDev/TeardownDev tear it down, EnsureGateway/ProvisionSshUser/
 * DeprovisionSshUser manage the per-host SSH gateway projection, GetTunnel reads
 * the (not-yet-launched) tunnel state, and a DEV_WORKSPACE deploy builds from the
 * agent's own workspace.
 *
 * The "remote" path is simulated by the LOCAL agent over loopback mTLS (the
 * sandbox has no second host); the wire contract + the agent's host-coupled work
 * are identical to a real remote. Run with: npx tsx scripts/agent-part-d-e2e.mts
 *
 * Not part of `npm test` (needs Docker + the built binary).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DEPLO_SECRET ||= "e2e-agent-secret-aaaaaaaaaaaaaaaaaaaa";
const DATA = mkdtempSync(join(tmpdir(), "deplo-agent-d-e2e-"));
process.env.DEPLO_DATA_DIR = DATA;
process.env.DEPLO_AGENT_BIN = join(process.cwd(), "agent/bin/deplo-agent");
process.env.DEPLO_AGENT_ADDR = "127.0.0.1:19445"; // avoid clashing with B/C

const SLUG = "agent-d-e2e";
const DEV_NAME = `deplo-dev-${SLUG}`;
const PROJECT_ID = "prj_d_e2e";

function sh(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { windowsHide: true });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name} ${detail}`);
  }
}

// A minimal rendered dev compose (the control plane's renderDevCompose output for
// an upload source). A persistent /workspace bind + the entry script bind, on the
// deplo network, labelled like a real dev container.
function devCompose(): string {
  return `services:
  ${DEV_NAME}:
    image: alpine:3.20
    container_name: ${DEV_NAME}
    restart: unless-stopped
    working_dir: /workspace
    tty: true
    stdin_open: true
    entrypoint: ["/bin/sh", "/usr/local/bin/deplo-dev-entry"]
    networks:
      - deplo
    volumes:
      - "${DATA}/dev/${SLUG}:/workspace"
      - "${DATA}/dev/_entry/deplo-dev-entry:/usr/local/bin/deplo-dev-entry:ro"
    labels:
      - "deplo.managed=true"
      - "deplo.project=${PROJECT_ID}"
      - "deplo.slug=${SLUG}"
      - "deplo.role=dev"
networks:
  deplo:
    external: true
`;
}

// A trivial entry script that just holds the container open (the real one seeds +
// drops to UID 1000; here we only need a running, labelled dev container).
const ENTRY = `#!/bin/sh
mkdir -p /workspace
exec tail -f /dev/null
`;

async function main() {
  const { connectAgent, agentPreflight } = await import("../lib/infra/agent-client");
  const { SourceKind, BuildKind } = await import("../lib/agent/gen/agent");

  console.log("== preflight ==");
  const hello = await agentPreflight("srv-local");
  if (!hello.dockerAvailable) throw new Error("agent reports docker unavailable");
  check("agent advertises the dev/ssh-gateway/tunnel capabilities",
    ["dev", "ssh-gateway", "tunnel"].every((c) => hello.capabilities.includes(c)),
    JSON.stringify(hello.capabilities));

  await sh("docker", ["network", "create", "deplo"]); // idempotent-ish; ignore err

  // ---- StartDev ----
  console.log("== StartDev ==");
  {
    const conn = await connectAgent("srv-local");
    try {
      let ready = false;
      for await (const ev of conn.startDev({
        slug: SLUG,
        projectId: PROJECT_ID,
        composeYaml: devCompose(),
        entryScript: ENTRY,
        cloneSecretUrl: "",
        uploadTar: Buffer.alloc(0),
        workspaceHostPath: "",
      })) {
        if (ev.result) ready = ev.result.ready;
      }
      check("StartDev reported ready", ready);
    } finally {
      conn.close();
    }
  }
  const devRunning = (await sh("docker", ["inspect", "-f", "{{.State.Running}}", DEV_NAME])).out.trim() === "true";
  check("dev container is running", devRunning);
  // The entry script was written to the agent's bind mount.
  const entryOnDisk = (await sh("cat", [`${DATA}/dev/_entry/deplo-dev-entry`])).out.includes("tail -f /dev/null");
  check("dev entrypoint script was written to the agent's data dir", entryOnDisk);

  // ---- Seed source then deploy from the dev workspace ----
  console.log("== seed workspace + DEV_WORKSPACE deploy ==");
  {
    // Put a buildable tree in the workspace (the agent builds from its OWN dir).
    writeFileSync(`${DATA}/dev/${SLUG}/Dockerfile`,
      "FROM busybox:latest\nCMD [\"sh\",\"-c\",\"while true; do sleep 1; done\"]\n");
    writeFileSync(`${DATA}/dev/${SLUG}/app.txt`, "hello from the dev workspace\n");

    const imageRef = `deplo/${SLUG}:devws`;
    const composeYaml = `services:
  deplo-${SLUG}:
    image: ${imageRef}
    container_name: deplo-${SLUG}
    labels:
      deplo.project: ${PROJECT_ID}
      deplo.slug: ${SLUG}
    restart: unless-stopped
    networks:
      - deplo
networks:
  deplo:
    external: true
`;
    const conn = await connectAgent("srv-local");
    try {
      let ready = false;
      let err = "";
      for await (const ev of conn.deploy({
        deployId: "dpl_d_devws",
        slug: SLUG,
        projectId: PROJECT_ID,
        imageRef,
        sourceKind: SourceKind.SOURCE_KIND_DEV_WORKSPACE,
        buildKind: BuildKind.BUILD_KIND_DOCKERFILE,
        dockerfile: { dockerfilePath: "Dockerfile", contextPath: ".", targetStage: "", generated: false, generatedDockerfile: "" },
        composeYaml,
        env: {},
        readyTimeoutMs: 60000,
        contextTar: new Uint8Array(0),
        pullImage: false,
        mounts: [],
        devWorkspaceSubdir: "",
      })) {
        if (ev.result) {
          ready = ev.result.ready;
          err = ev.result.error;
        }
      }
      check("DEV_WORKSPACE deploy built from the agent's own workspace", ready, err);
    } finally {
      conn.close();
    }
    const prodRunning = (await sh("docker", ["inspect", "-f", "{{.State.Running}}", `deplo-${SLUG}`])).out.trim() === "true";
    check("the dev-workspace image is running in production", prodRunning);
    await sh("docker", ["rm", "-f", `deplo-${SLUG}`]);
  }

  // ---- Tunnel (read-only; no Microsoft login in CI) ----
  console.log("== GetTunnel ==");
  {
    const conn = await connectAgent("srv-local");
    try {
      const t = await conn.getTunnel(SLUG);
      // No tunnel was launched, so it reports not-running with an empty log.
      check("GetTunnel reads a clean (not-running) state", t.running === false, JSON.stringify(t));
    } finally {
      conn.close();
    }
  }

  // ---- SSH gateway: ensure + provision a user + verify + deprovision ----
  console.log("== EnsureGateway + ProvisionSshUser ==");
  {
    const gw = await import("../lib/infra/gateway-config");
    const proj = await import("../lib/infra/gateway-projection");
    const SENTINEL = "__DEPLO_GW_HOST_DIR__";
    const config = {
      composeYaml: gw.renderGatewayCompose(SENTINEL),
      sshdConfig: gw.SSHD_CONFIG,
      wrapperScript: gw.WRAPPER_SCRIPT,
      entrypointScript: gw.GATEWAY_ENTRYPOINT,
      socketFilterCfg: gw.SOCKET_FILTER_CFG,
    };
    const username = `${SLUG}-alice`;
    const steps = proj
      .provisionSteps(
        { username, password: "s3cret-pw", publicKey: null },
        { slug: SLUG, container: DEV_NAME },
      )
      .map((s) => ({ argv: s.argv, input: s.input ?? "" }));

    const conn = await connectAgent("srv-local");
    try {
      const res = await conn.ensureGateway(config, [steps]);
      check("EnsureGateway succeeded", res.ok, res.error);
    } finally {
      conn.close();
    }
    // The gateway container is up.
    await sleep(1000);
    const gwUp = (await sh("docker", ["inspect", "-f", "{{.State.Running}}", "deplo-ssh-gateway"])).out.trim() === "true";
    check("the SSH gateway container is running", gwUp);
    // The provisioned account exists inside the gateway (the projection landed).
    const idOut = (await sh("docker", ["exec", "deplo-ssh-gateway", "id", username])).out;
    check("the provisioned user account exists in the gateway", /uid=\d+/.test(idOut), idOut);
    // The map file was written (root-owned, SLUG + DEV_CONTAINER).
    const mapOut = (await sh("docker", ["exec", "deplo-ssh-gateway", "cat", `/data/ssh-gateway/map/${username}`])).out;
    check("the user's map file maps to the dev container", mapOut.includes(DEV_NAME), mapOut);

    // ---- DeprovisionSshUser ----
    console.log("== DeprovisionSshUser ==");
    const dsteps = proj.deprovisionSteps(username).map((s) => ({ argv: s.argv, input: s.input ?? "" }));
    {
      const c2 = await connectAgent("srv-local");
      try {
        const res = await c2.deprovisionSshUser(dsteps);
        check("DeprovisionSshUser succeeded", res.ok, res.error);
      } finally {
        c2.close();
      }
    }
    const idAfter = await sh("docker", ["exec", "deplo-ssh-gateway", "id", username]);
    // `id <gone-user>` exits non-zero with an "unknown/no such user" message.
    check("the user account is gone after deprovision",
      idAfter.code !== 0 && /unknown user|no such user|not found/i.test(idAfter.out), idAfter.out);
  }

  // ---- StopDev then TeardownDev ----
  console.log("== StopDev + TeardownDev ==");
  {
    const conn = await connectAgent("srv-local");
    try {
      await conn.stopDev(SLUG);
    } finally {
      conn.close();
    }
    const afterStop = (await sh("docker", ["inspect", "-f", "{{.State.Running}}", DEV_NAME])).out.trim();
    check("StopDev brought the dev container down", afterStop !== "true", afterStop);

    const conn2 = await connectAgent("srv-local");
    try {
      await conn2.teardownDev(SLUG);
    } finally {
      conn2.close();
    }
    const gone = (await sh("docker", ["inspect", DEV_NAME])).code !== 0;
    check("TeardownDev removed the dev container", gone);
    // The workspace dir was wiped.
    const wsGone = (await sh("test", ["-d", `${DATA}/dev/${SLUG}`])).code !== 0;
    check("TeardownDev wiped the workspace dir", wsGone);
  }

  // ---- cleanup ----
  await sh("docker", ["rm", "-f", "deplo-ssh-gateway", "deplo-ssh-gateway-proxy", DEV_NAME]);
  await sh("docker", ["volume", "rm", "-f", `deplo-dev-${SLUG}-deps`]);
  rmSync(DATA, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  killLocalAgent();
  process.exit(fail === 0 ? 0 : 1);
}

function killLocalAgent(): void {
  try {
    const key = Symbol.for("deplo.localAgent.supervisor");
    const st = (globalThis as Record<symbol, unknown>)[key] as
      | { proc?: { kill?: (s?: string) => void } | null }
      | undefined;
    st?.proc?.kill?.("SIGKILL");
  } catch {
    /* best-effort */
  }
}

main().catch((e) => {
  console.error("E2E ERROR:", e);
  killLocalAgent();
  process.exit(1);
});
