/**
 * End-to-end smoke test for the server agent's PART B path, against the REAL
 * binary + real Docker + real git, with a SIMULATED remote: the agent is run as
 * if it were a freshly-installed remote box (no pre-written certs), it CALLS HOME
 * to a tiny stand-in for /api/agent/bootstrap that signs its CSR with the real
 * control-plane PKI, then it serves gRPC and the control plane dials it with
 * FINGERPRINT PINNING. Proves the trust inversion (P1-P4), a GIT-source deploy
 * (D3), and reconnection/replay (D5) without needing a second machine.
 *
 * Run: npx tsx scripts/agent-part-b-e2e.mts   (needs Docker + git + the binary)
 * Not part of `npm test`. Complements the Go + TS unit tests with a machine-to-
 * machine proof.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DEPLO_SECRET ||= "part-b-e2e-secret-bbbbbbbbbbbbbbbbbbbb";
const AGENT_BIN = join(process.cwd(), "agent/bin/deplo-agent");
const AGENT_ADDR = "127.0.0.1:19553";
const AGENT_HOST = "127.0.0.1";
const AGENT_PORT = 19553;
const SLUG = "agent-partb-demo";
const NAME = `deplo-${SLUG}`;
const DEPLOY_ID = "dpl_e2e_partb_1";

function sh(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { windowsHide: true, cwd: opts.cwd });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { signAgentCsr } = await import("../lib/agent/pki");
  const { connectAgent } = await import("../lib/infra/agent-client");
  const {
    SourceKind,
    BuildKind,
    ContractVersion,
  } = await import("../lib/agent/gen/agent");

  // ---- 1. A tiny stand-in for POST /api/agent/bootstrap (HTTP trust path). ----
  // It signs the CSR with the REAL control-plane PKI and HMAC-binds the response.
  const { createHmac } = await import("node:crypto");
  let pinnedFingerprint = "";
  const bootstrapServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { token, csrPem } = JSON.parse(body) as { token: string; csrPem: string };
        if (token !== "e2e-bootstrap-token") {
          res.writeHead(401).end(JSON.stringify({ error: "unknown-token" }));
          return;
        }
        const signed = await signAgentCsr(csrPem, [AGENT_HOST]);
        pinnedFingerprint = signed.fingerprint;
        const payload = JSON.stringify({ certPem: signed.certPem, caPem: signed.caPem });
        const mac = createHmac("sha256", token).update(payload).digest("hex");
        res.writeHead(200, { "content-type": "application/json", "x-deplo-bootstrap-mac": mac });
        res.end(payload);
      } catch (e) {
        res.writeHead(500).end(String(e));
      }
    });
  });
  const cpPort = await new Promise<number>((resolve) => {
    bootstrapServer.listen(0, "127.0.0.1", () => {
      resolve((bootstrapServer.address() as { port: number }).port);
    });
  });
  const cpUrl = `http://127.0.0.1:${cpPort}`;
  console.log(`== bootstrap stand-in listening at ${cpUrl} ==`);

  // ---- 2. Run the agent as a fresh "remote": no certs, bootstrap on first run. ----
  const agentDir = mkdtempSync(join(tmpdir(), "deplo-partb-agent-"));
  console.log("== launching agent in BOOTSTRAP mode (simulated remote) ==");
  const agent: ChildProcess = spawn(
    AGENT_BIN,
    [
      "--addr", AGENT_ADDR,
      "--agent-dir", agentDir,
      "--bootstrap-url", cpUrl,
      "--bootstrap-token", "e2e-bootstrap-token",
      // no fingerprint => HTTP trust path (HMAC)
      "--stack-dir", join(agentDir, "stacks"),
      "--build-tmp", join(agentDir, "tmp"),
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  agent.on("exit", (c) => console.log(`agent exited (${c})`));

  // ---- 3. Build a remote-style dial target with fingerprint pinning. ----
  // Mirror lib/infra/agent-client.remoteTarget() but inline so we don't need a
  // store-backed Server row. Wait for bootstrap to produce the fingerprint +
  // for the agent to start serving.
  for (let i = 0; i < 100 && !pinnedFingerprint; i++) await sleep(100);
  if (!pinnedFingerprint) throw new Error("agent never called home");
  console.log("  agent provisioned; pinned fingerprint:", pinnedFingerprint.slice(0, 16) + "…");

  // Dial through the real connectAgent by faking a Server row in the store.
  const { mutate } = await import("../lib/store");
  const { caCertPem } = await import("../lib/agent/pki");
  void (await caCertPem());
  mutate((d) => {
    d.servers = d.servers.filter((s) => s.id !== "srv-e2e-remote");
    d.servers.push({
      id: "srv-e2e-remote",
      name: "e2e-remote",
      host: AGENT_HOST,
      type: "remote",
      status: "online",
      ip: AGENT_HOST,
      dockerVersion: "",
      traefikEnabled: false,
      cpuCores: 0, memoryMb: 0, diskGb: 0,
      cpuUsage: 0, memoryUsage: 0, diskUsage: 0,
      createdAt: new Date(0).toISOString(),
      agent: { port: AGENT_PORT, certFingerprint: pinnedFingerprint, certPem: "", version: "" },
    } as never);
  });

  // Wait for the gRPC listener (Hello) over the pinned mTLS channel.
  let helloOk = false;
  for (let i = 0; i < 100; i++) {
    try {
      const conn = await connectAgent("srv-e2e-remote");
      const h = await conn.hello();
      conn.close();
      if (h.contractVersion === ContractVersion.CONTRACT_VERSION_V1) {
        helloOk = true;
        console.log("== Hello over pinned mTLS OK ==", "docker:", h.dockerAvailable);
        break;
      }
    } catch {
      await sleep(150);
    }
  }
  if (!helloOk) throw new Error("never completed Hello over pinned mTLS");

  // ---- 4. A GIT deploy (D3): a tiny local git repo with a Dockerfile. ----
  const repoDir = mkdtempSync(join(tmpdir(), "deplo-partb-repo-"));
  writeFileSync(join(repoDir, "Dockerfile"), "FROM busybox\nCMD [\"sh\",\"-c\",\"sleep 3600\"]\n");
  await sh("git", ["init", "-q"], { cwd: repoDir });
  await sh("git", ["config", "user.email", "e2e@deplo.test"], { cwd: repoDir });
  await sh("git", ["config", "user.name", "e2e"], { cwd: repoDir });
  await sh("git", ["add", "-A"], { cwd: repoDir });
  await sh("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });
  const expectedSha = (await sh("git", ["rev-parse", "HEAD"], { cwd: repoDir })).out.trim();

  const composeYaml = [
    "services:",
    `  ${SLUG}:`,
    `    image: deplo/${SLUG}:e2e`,
    `    container_name: ${NAME}`,
    "    networks: [deplo]",
    "networks:",
    "  deplo:",
    "    external: true",
  ].join("\n") + "\n";

  console.log("== GIT deploy through the agent (agent clones file:// repo) ==");
  const conn = await connectAgent("srv-e2e-remote");
  let ready = false;
  let gotSha = "";
  let lastSeq = 0;
  for await (const ev of conn.deploy({
    deployId: DEPLOY_ID,
    slug: SLUG,
    projectId: "prj_e2e",
    imageRef: `deplo/${SLUG}:e2e`,
    sourceKind: SourceKind.SOURCE_KIND_GIT,
    buildKind: BuildKind.BUILD_KIND_DOCKERFILE,
    dockerfile: { dockerfilePath: "Dockerfile", contextPath: ".", targetStage: "", generated: false, generatedDockerfile: "" },
    git: { url: `file://${repoDir}`, branch: "", token: "", subdir: "" },
    composeYaml,
    env: {},
    readyTimeoutMs: 60_000,
    contextTar: new Uint8Array(0),
    pullImage: false,
  })) {
    if (ev.seq) lastSeq = Number(ev.seq);
    if (ev.log) process.stdout.write(`  [${ev.log.level}] ${ev.log.text}\n`);
    if (ev.result) { ready = ev.result.ready; gotSha = ev.result.commitSha; }
  }
  conn.close();
  if (!ready) throw new Error("git deploy did not reach ready");
  console.log("  git deploy ready; agent-resolved sha:", gotSha);
  if (gotSha !== expectedSha) throw new Error(`commit sha mismatch: got ${gotSha}, want ${expectedSha}`);
  const running = (await sh("docker", ["inspect", "-f", "{{.State.Running}}", NAME])).out.trim();
  if (running !== "true") throw new Error(`container not running: ${running}`);
  console.log("  container is running ✓");

  // ---- 5. Reattach/replay (D5): reconnect to the just-finished deploy. ----
  console.log("== reattach to the finished deploy and replay from seq 0 ==");
  const conn2 = await connectAgent("srv-e2e-remote");
  let replayCount = 0;
  let replayResult = false;
  for await (const ev of conn2.reattach({ deployId: DEPLOY_ID, fromSeq: 0 })) {
    replayCount++;
    if (ev.result) replayResult = ev.result.ready;
  }
  conn2.close();
  console.log(`  replayed ${replayCount} events (live stream had seq up to ${lastSeq}); terminal ready=${replayResult}`);
  if (!replayResult) throw new Error("reattach did not replay the terminal result");
  if (replayCount < lastSeq) throw new Error("reattach replayed fewer events than were buffered");

  // ---- 6. MID-FLIGHT drop + reattach (D5, the real promise). ----
  // Start a second deploy, abandon the Deploy stream after the first event (as if
  // the control plane crashed mid-build), then reattach from the cursor and
  // follow it to completion — the build kept going on the agent's background ctx.
  await sh("docker", ["rm", "-f", NAME]);
  const DEPLOY_ID_2 = "dpl_e2e_partb_2";
  console.log("== mid-flight: start deploy, drop after 1 event, reattach ==");
  const c3 = await connectAgent("srv-e2e-remote");
  let cursor = 0;
  for await (const ev of c3.deploy({
    deployId: DEPLOY_ID_2,
    slug: SLUG,
    projectId: "prj_e2e",
    imageRef: `deplo/${SLUG}:e2e`,
    sourceKind: SourceKind.SOURCE_KIND_GIT,
    buildKind: BuildKind.BUILD_KIND_DOCKERFILE,
    dockerfile: { dockerfilePath: "Dockerfile", contextPath: ".", targetStage: "", generated: false, generatedDockerfile: "" },
    git: { url: `file://${repoDir}`, branch: "", token: "", subdir: "" },
    composeYaml,
    env: {},
    readyTimeoutMs: 60_000,
    contextTar: new Uint8Array(0),
    pullImage: false,
  })) {
    if (ev.seq) cursor = Number(ev.seq);
    break; // DROP: simulate the control plane losing the stream mid-build
  }
  c3.close();
  console.log(`  dropped after seq ${cursor}; the agent keeps building…`);

  const c4 = await connectAgent("srv-e2e-remote");
  let reReady = false;
  let reGotResultAfterDrop = false;
  for await (const ev of c4.reattach({ deployId: DEPLOY_ID_2, fromSeq: cursor })) {
    if (Number(ev.seq) <= cursor) throw new Error("reattach replayed an event we already saw");
    if (ev.result) { reReady = ev.result.ready; reGotResultAfterDrop = true; }
  }
  c4.close();
  if (!reGotResultAfterDrop || !reReady) throw new Error("mid-flight reattach did not complete the deploy");
  const running2 = (await sh("docker", ["inspect", "-f", "{{.State.Running}}", NAME])).out.trim();
  if (running2 !== "true") throw new Error(`mid-flight: container not running: ${running2}`);
  console.log("  reattached from the cursor and the deploy completed ✓");

  // ---- Cleanup ----
  await sh("docker", ["rm", "-f", NAME]);
  agent.kill("SIGKILL");
  bootstrapServer.close();
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
  console.log("\n✅ Part B e2e passed: bootstrap (CSR-signed) + pinned mTLS + git deploy + reattach.");
  process.exit(0);
}

main().catch((e) => {
  console.error("\n❌ Part B e2e FAILED:", e);
  process.exit(1);
});
