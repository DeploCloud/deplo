// node --require ./lib/test/server-only-shim.cjs --import tsx scripts/agent-part-b-e2e.mts [--link]
// DEPLO_AGENT_BIN names the agent build (a semver VERSION, or the agentMin gate refuses it). --link
// needs no database and deploys nothing: real agents link into the real door (ADR-0040).
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

process.env.DEPLO_SECRET ||= "part-b-e2e-secret-bbbbbbbbbbbbbbbbbbbb";
const AGENT_BIN =
  process.env.DEPLO_AGENT_BIN || join(process.cwd(), "agent/bin/deplo-agent");
const AGENT_ADDR = "127.0.0.1:19553";
const AGENT_HOST = "127.0.0.1";
const AGENT_PORT = 19553;
const SLUG = "agent-partb-demo";
const NAME = `deplo-${SLUG}`;
const DEPLOY_ID = "dpl_e2e_partb_1";

function sh(
  cmd: string,
  args: string[],
  opts: { cwd?: string } = {},
): Promise<{ code: number; out: string }> {
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
  const { connectAgent } = await import("../lib/infra/agent-client/connect");
  const { SourceKind, BuildKind, ContractVersion } =
    await import("../lib/agent/gen/agent");

  const { createHmac } = await import("node:crypto");
  let pinnedFingerprint = "";
  const bootstrapServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { token, csrPem } = JSON.parse(body) as {
          token: string;
          csrPem: string;
        };
        if (token !== "e2e-bootstrap-token") {
          res.writeHead(401).end(JSON.stringify({ error: "unknown-token" }));
          return;
        }
        const signed = await signAgentCsr(csrPem, [AGENT_HOST]);
        pinnedFingerprint = signed.fingerprint;
        const payload = JSON.stringify({
          certPem: signed.certPem,
          caPem: signed.caPem,
        });
        const mac = createHmac("sha256", token).update(payload).digest("hex");
        res.writeHead(200, {
          "content-type": "application/json",
          "x-deplo-bootstrap-mac": mac,
        });
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

  const agentDir = mkdtempSync(join(tmpdir(), "deplo-partb-agent-"));
  console.log("== launching agent in BOOTSTRAP mode (simulated remote) ==");
  const agent: ChildProcess = spawn(
    AGENT_BIN,
    [
      "--addr",
      AGENT_ADDR,
      "--agent-dir",
      agentDir,
      "--bootstrap-url",
      cpUrl,
      "--bootstrap-token",
      "e2e-bootstrap-token",
      "--stack-dir",
      join(agentDir, "stacks"),
      "--build-tmp",
      join(agentDir, "tmp"),
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  agent.on("exit", (c) => console.log(`agent exited (${c})`));

  for (let i = 0; i < 100 && !pinnedFingerprint; i++) await sleep(100);
  if (!pinnedFingerprint) throw new Error("agent never called home");
  console.log(
    "  agent provisioned; pinned fingerprint:",
    pinnedFingerprint.slice(0, 16) + "…",
  );

  const { getDb } = await import("../lib/db/client");
  const { servers: serversTable } =
    await import("../lib/db/schema/control-plane/servers");
  const { serverToRow } = await import("../lib/data/infra-rows");
  const { eq } = await import("drizzle-orm");
  const { caCertPem } = await import("../lib/agent/pki");
  void (await caCertPem());
  const db = getDb();
  await db.delete(serversTable).where(eq(serversTable.id, "srv-e2e-remote"));
  await db.insert(serversTable).values(
    serverToRow({
      id: "srv-e2e-remote",
      name: "e2e-remote",
      host: AGENT_HOST,
      type: "remote",
      status: "online",
      ip: AGENT_HOST,
      dockerVersion: "",
      traefikEnabled: false,
      cpuCores: 0,
      memoryMb: 0,
      diskGb: 0,
      allTeams: true,
      storageOnly: false,
      buildOnly: false,
      buildFallback: null,
      generatedAddressFamily: null,
      importOnly: false,
      uninstallPending: false,
      uninstallError: "",
      hostArch: "amd64",
      deployConcurrency: 1,
      createdAt: new Date(0).toISOString(),
      agent: {
        port: AGENT_PORT,
        certFingerprint: pinnedFingerprint,
        certPem: "",
        version: "",
      },
    }),
  );

  let helloOk = false;
  for (let i = 0; i < 100; i++) {
    try {
      const conn = await connectAgent("srv-e2e-remote");
      const h = await conn.hello();
      conn.close();
      if (h.contractVersion === ContractVersion.CONTRACT_VERSION_V1) {
        helloOk = true;
        console.log(
          "== Hello over pinned mTLS OK ==",
          "docker:",
          h.dockerAvailable,
        );
        break;
      }
    } catch {
      await sleep(150);
    }
  }
  if (!helloOk) throw new Error("never completed Hello over pinned mTLS");

  const repoDir = mkdtempSync(join(tmpdir(), "deplo-partb-repo-"));
  writeFileSync(
    join(repoDir, "Dockerfile"),
    'FROM busybox\nCMD ["sh","-c","sleep 3600"]\n',
  );
  await sh("git", ["init", "-q"], { cwd: repoDir });
  await sh("git", ["config", "user.email", "e2e@deplo.test"], { cwd: repoDir });
  await sh("git", ["config", "user.name", "e2e"], { cwd: repoDir });
  await sh("git", ["add", "-A"], { cwd: repoDir });
  await sh("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });
  const expectedSha = (
    await sh("git", ["rev-parse", "HEAD"], { cwd: repoDir })
  ).out.trim();

  const composeYaml =
    [
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
    dockerfile: {
      dockerfilePath: "Dockerfile",
      contextPath: ".",
      targetStage: "",
      generated: false,
      generatedDockerfile: "",
    },
    git: {
      url: `file://${repoDir}`,
      branch: "",
      commit: "",
      token: "",
      subdir: "",
      submodules: false,
    },
    composeYaml,
    network: "deplo-team-e2e",
    env: {},
    readyTimeoutMs: 60_000,
    contextTar: new Uint8Array(0),
    pullImage: false,
    mounts: [],
    devWorkspaceSubdir: "",
    noBuildCache: false,
    forceRecreate: false,
    composeUpArgs: [],
    buildOnly: false,
    registryAuth: [],
    filesBindSources: [],
    githubToken: "",
    pullBaseImages: false,
  })) {
    if (ev.seq) lastSeq = Number(ev.seq);
    if (ev.log) process.stdout.write(`  [${ev.log.level}] ${ev.log.text}\n`);
    if (ev.result) {
      ready = ev.result.ready;
      gotSha = ev.result.commitSha;
    }
  }
  conn.close();
  if (!ready) throw new Error("git deploy did not reach ready");
  console.log("  git deploy ready; agent-resolved sha:", gotSha);
  if (gotSha !== expectedSha)
    throw new Error(`commit sha mismatch: got ${gotSha}, want ${expectedSha}`);
  const running = (
    await sh("docker", ["inspect", "-f", "{{.State.Running}}", NAME])
  ).out.trim();
  if (running !== "true") throw new Error(`container not running: ${running}`);
  console.log("  container is running ✓");

  console.log("== reattach to the finished deploy and replay from seq 0 ==");
  const conn2 = await connectAgent("srv-e2e-remote");
  let replayCount = 0;
  let replayResult = false;
  for await (const ev of conn2.reattach({ deployId: DEPLOY_ID, fromSeq: 0 })) {
    replayCount++;
    if (ev.result) replayResult = ev.result.ready;
  }
  conn2.close();
  console.log(
    `  replayed ${replayCount} events (live stream had seq up to ${lastSeq}); terminal ready=${replayResult}`,
  );
  if (!replayResult)
    throw new Error("reattach did not replay the terminal result");
  if (replayCount < lastSeq)
    throw new Error("reattach replayed fewer events than were buffered");

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
    dockerfile: {
      dockerfilePath: "Dockerfile",
      contextPath: ".",
      targetStage: "",
      generated: false,
      generatedDockerfile: "",
    },
    git: {
      url: `file://${repoDir}`,
      branch: "",
      commit: "",
      token: "",
      subdir: "",
      submodules: false,
    },
    composeYaml,
    network: "deplo-team-e2e",
    env: {},
    readyTimeoutMs: 60_000,
    contextTar: new Uint8Array(0),
    pullImage: false,
    mounts: [],
    devWorkspaceSubdir: "",
    noBuildCache: false,
    forceRecreate: false,
    composeUpArgs: [],
    buildOnly: false,
    registryAuth: [],
    filesBindSources: [],
    githubToken: "",
    pullBaseImages: false,
  })) {
    if (ev.seq) cursor = Number(ev.seq);
    break;
  }
  c3.close();
  console.log(`  dropped after seq ${cursor}; the agent keeps building…`);

  const c4 = await connectAgent("srv-e2e-remote");
  let reReady = false;
  let reGotResultAfterDrop = false;
  for await (const ev of c4.reattach({
    deployId: DEPLOY_ID_2,
    fromSeq: cursor,
  })) {
    if (Number(ev.seq) <= cursor)
      throw new Error("reattach replayed an event we already saw");
    if (ev.result) {
      reReady = ev.result.ready;
      reGotResultAfterDrop = true;
    }
  }
  c4.close();
  if (!reGotResultAfterDrop || !reReady)
    throw new Error("mid-flight reattach did not complete the deploy");
  const running2 = (
    await sh("docker", ["inspect", "-f", "{{.State.Running}}", NAME])
  ).out.trim();
  if (running2 !== "true")
    throw new Error(`mid-flight: container not running: ${running2}`);
  console.log("  reattached from the cursor and the deploy completed ✓");

  await sh("docker", ["rm", "-f", NAME]);
  agent.kill("SIGKILL");
  bootstrapServer.close();
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
  console.log(
    "\n✅ Part B e2e passed: bootstrap (CSR-signed) + pinned mTLS + git deploy + reattach.",
  );
  process.exit(0);
}

// The host's Docker is shared: an agent here may read, and run a throwaway container on an agentlink-* volume.
const DOCKER_GUARD = (docker: string) => `#!/bin/sh
case "$1 $2" in
  "version "* | "info "* | "inspect "* | "ps "* | "image inspect" | "volume inspect" | "container inspect") exec ${docker} "$@" ;;
  "run "*) case " $* " in *" --rm "*" -v agentlink-"*) exec ${docker} "$@" ;; esac ;;
esac
echo "refused by the agent link e2e: docker $*" >&2
exit 1
`;

/** The one file in a tar stream named `name`, or null. */
function tarEntry(tar: Buffer, name: string): Buffer | null {
  for (let off = 0; off + 512 <= tar.length;) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) return null;
    const field = (from: number, to: number) =>
      header
        .subarray(from, to)
        .toString()
        .replace(/\0[\s\S]*$/, "")
        .trim();
    const size = parseInt(field(124, 136) || "0", 8);
    if (field(0, 100).replace(/^\.\//, "") === name)
      return tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

async function linkMain() {
  process.env.NODE_TEST_CONTEXT ||= "agent-link-e2e"; // an in-process database, never a real one
  process.env.DEPLO_SERVER_IP = "192.0.2.10";
  const { makeTestDb } = await import("../lib/db/test-harness");
  const { __setTestDb } = await import("../lib/db/client");
  const { db } = await makeTestDb();
  __setTestDb(db);

  const { startAgentLinkListener, stopAgentLinkListener } =
    await import("../lib/infra/agent-link/listener");
  const { waitForLink } = await import("../lib/infra/agent-link/registry");
  const { connectAgent } = await import("../lib/infra/agent-client/connect");
  const { mintBootstrap } = await import("../lib/agent/bootstrap");
  const { serverToRow } = await import("../lib/data/infra-rows");
  const { servers } = await import("../lib/db/schema/control-plane/servers");
  const { POST: bootstrapRoute } =
    await import("../app/api/agent/bootstrap/route");

  const { port: door } = await startAgentLinkListener({
    port: 0,
    host: "127.0.0.1",
  });
  // Agent 0 is handed the loopback port install.sh publishes; any other server the public address,
  // which Traefik routes to the door. Both are the door here, under two spellings.
  process.env.DEPLO_LINK_PORT = String(door);
  process.env.DEPLO_PUBLIC_URL = `http://localhost:${door}`;
  const want: Record<string, string> = {
    "srv-e2e-self": `http://127.0.0.1:${door}`,
    "srv-e2e-remote": `http://localhost:${door}`,
  };

  // Call home goes to the real route on ANOTHER port, so a link proves the agent kept the address it was handed.
  const home = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const out = await bootstrapRoute(
        new Request(`http://127.0.0.1${req.url}`, { method: "POST", body }),
      );
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(await out.text());
    });
  });
  const homePort = await new Promise<number>((resolve) =>
    home.listen(0, "127.0.0.1", () =>
      resolve((home.address() as { port: number }).port),
    ),
  );

  const docker = (await sh("sh", ["-c", "command -v docker"])).out.trim();
  if (!docker) throw new Error("no docker on PATH");
  const guardDir = mkdtempSync(join(tmpdir(), "agentlink-docker-"));
  writeFileSync(join(guardDir, "docker"), DOCKER_GUARD(docker));
  chmodSync(join(guardDir, "docker"), 0o755);
  const volume = `agentlink-e2e-${process.pid}`;
  const agents: E2eAgent[] = [];
  // Enrolls a server and starts its agent; `extra` flags ride every restart, as a unit's argv does.
  const enroll = async (id: string, ip: string, extra: string[] = []) => {
    const { rawToken, stored } = mintBootstrap();
    await db.insert(servers).values(
      serverToRow({
        id,
        name: id,
        host: ip,
        type: "remote",
        status: "provisioning",
        ip,
        dockerVersion: "",
        traefikEnabled: false,
        cpuCores: 0,
        memoryMb: 0,
        diskGb: 0,
        allTeams: true,
        storageOnly: false,
        buildOnly: false,
        buildFallback: null,
        generatedAddressFamily: null,
        importOnly: false,
        uninstallPending: false,
        uninstallError: "",
        hostArch: "amd64",
        deployConcurrency: 1,
        createdAt: new Date(0).toISOString(),
        bootstrap: stored,
      }),
    );
    const dir = mkdtempSync(join(tmpdir(), "agentlink-agent-"));
    const argv = [
      ...extra,
      "--agent-dir",
      dir,
      "--bootstrap-url",
      `http://127.0.0.1:${homePort}`,
      "--bootstrap-token",
      rawToken,
      "--stack-dir",
      join(dir, "stacks"),
      "--build-tmp",
      join(dir, "tmp"),
    ];
    const start = () =>
      spawn(AGENT_BIN, argv, {
        stdio: ["ignore", "inherit", "inherit"],
        // Nothing of this process's environment: only the guarded Docker, and a temp dir that
        // is not the host's (an agent's start sweeps its own leftovers there).
        env: {
          NODE_ENV: "test",
          PATH: `${guardDir}:${process.env.PATH}`,
          HOME: dir,
          TMPDIR: join(dir, "tmp"),
        },
      });
    const agent: E2eAgent = {
      id,
      dir,
      proc: start(),
      async restart() {
        const exited = new Promise((r) => agent.proc.once("exit", r));
        agent.proc.kill("SIGTERM");
        await exited;
        agent.proc = start();
      },
    };
    agents.push(agent);
    return agent;
  };
  try {
    // No --addr: a linking agent is installed with none and listens on nothing.
    await enroll("srv-e2e-self", process.env.DEPLO_SERVER_IP!);
    await enroll("srv-e2e-remote", "198.51.100.7");

    for (const { id, dir, proc } of agents) {
      if (!(await waitForLink(id, 20_000)))
        throw new Error(`${id} never linked`);
      const saved = JSON.parse(
        readFileSync(join(dir, "link-addresses.json"), "utf8"),
      ) as { primary: string };
      if (saved.primary !== want[id])
        throw new Error(`${id} saved ${saved.primary}, want ${want[id]}`);
      const listening = await listensOn(proc.pid);
      if (listening.length)
        throw new Error(`${id} listens: ${listening.join("; ")}`);
      const conn = await connectAgent(id);
      const hello = await conn.hello();
      conn.close();
      if (!hello.capabilities.includes("agent-link"))
        throw new Error(`${id} Hello: ${hello.capabilities.join(",")}`);
      console.log(
        `== ${id}: linked to ${saved.primary}, no listener, Hello ${hello.agentVersion} ✓`,
      );
    }

    await linkAddressesE2e(door, agents);
    await listenerE2e(enroll);

    const fill = await sh("docker", [
      "run",
      "--rm",
      "--name",
      `${volume}-fill`,
      "-v",
      `${volume}:/v`,
      "busybox:1.36",
      "sh",
      "-c",
      "head -c 33554432 /dev/urandom > /v/blob && sha256sum /v/blob",
    ]);
    if (fill.code !== 0) throw new Error(`fill ${volume}: ${fill.out}`);
    const sha = fill.out.trim().split(/\s+/)[0];
    const started = Date.now();
    const conn = await connectAgent("srv-e2e-self");
    const chunks: Buffer[] = [];
    for await (const chunk of conn.exportVolume(volume)) chunks.push(chunk);
    conn.close();
    const gz = Buffer.concat(chunks);
    const blob = tarEntry(gunzipSync(gz), "blob");
    const got = blob && createHash("sha256").update(blob).digest("hex");
    if (got !== sha) throw new Error(`export over the link: ${got} != ${sha}`);
    const secs = (Date.now() - started) / 1000;
    console.log(
      `== volume export over agent 0's link: ${(gz.length / 1048576).toFixed(1)} MiB in ${secs.toFixed(1)} s, byte-identical ✓`,
    );
    console.log("\n✅ agent link e2e passed");
  } finally {
    for (const { proc } of agents) proc.kill("SIGTERM");
    await sh("docker", ["volume", "rm", "-f", volume]);
    await stopAgentLinkListener();
    home.close();
    for (const { dir } of agents) rmSync(dir, { recursive: true, force: true });
    rmSync(guardDir, { recursive: true, force: true });
  }
}

interface E2eAgent {
  id: string;
  dir: string;
  proc: ChildProcess;
  /** Stops it and starts it again with the same flags, as systemd or a self-update would. */
  restart(): Promise<void>;
}

const listensOn = async (pid: number | undefined) =>
  (await sh("ss", ["-ltnpH"])).out
    .split("\n")
    .filter((l) => l.includes(`pid=${pid},`));

// An agent from before the link (#119): it listens, links, and closes its port once the panel saw the link.
async function listenerE2e(
  enroll: (id: string, ip: string, extra: string[]) => Promise<E2eAgent>,
) {
  const { connectAgent } = await import("../lib/infra/agent-client/connect");
  const { currentLink, onAgentLink, waitForLink } =
    await import("../lib/infra/agent-link/registry");
  const { startLinkAddressSync, stopLinkAddressSync } =
    await import("../lib/data/servers/link-addresses");
  const until = async (what: string, ok: () => Promise<boolean> | boolean) => {
    for (const end = Date.now() + 20_000; !(await ok()); await sleep(100))
      if (Date.now() > end) throw new Error(`never: ${what}`);
  };
  const listening = async (id: string) => {
    const conn = await connectAgent(id);
    try {
      return (await conn.hello()).listening;
    } finally {
      conn.close();
    }
  };
  const free = createServer();
  await new Promise<void>((r) => free.listen(0, "127.0.0.1", r));
  const port = (free.address() as { port: number }).port;
  await new Promise((r) => free.close(r));
  const id = "srv-e2e-listening";

  const firstLink = new Promise<boolean>((resolve) => {
    const off = onAgentLink((e) => {
      if (e.serverId === id && e.type === "up") resolve(e.hello.listening);
      if (e.serverId === id) off();
    });
  });
  startLinkAddressSync();
  try {
    const agent = await enroll(id, "198.51.100.8", [
      "--addr",
      `127.0.0.1:${port}`,
    ]);
    if (!(await waitForLink(id, 20_000))) throw new Error(`${id} never linked`);
    if (!(await firstLink)) throw new Error(`${id} linked without listening`);
    await until("its port closes", async () => {
      return (await listensOn(agent.proc.pid)).length === 0;
    });
    if (await listening(id)) throw new Error(`${id} Hello still listens`);
    readFileSync(join(agent.dir, "no-listener")); // what a restart reads
    console.log(
      `== ${id}: listened on 127.0.0.1:${port}, linked, was told to stop, its socket is gone ✓`,
    );

    const before = currentLink(id);
    await agent.restart();
    await until("a link from the restarted agent", () => {
      const now = currentLink(id);
      return !!now && now !== before;
    });
    const open = await listensOn(agent.proc.pid);
    if (open.length) throw new Error(`${id} listens again: ${open.join("; ")}`);
    if (await listening(id)) throw new Error(`${id} Hello listens again`);
    console.log(
      `== ${id}: restarted with --addr 127.0.0.1:${port} again, relinked, still no listener ✓`,
    );
  } finally {
    await stopLinkAddressSync();
  }
}

// The panel names both addresses (#118): a replaced pair is dialed next, primary then fallback.
async function linkAddressesE2e(
  door: number,
  agents: { id: string; dir: string }[],
) {
  const { connectAgent } = await import("../lib/infra/agent-client/connect");
  const { currentLink } = await import("../lib/infra/agent-link/registry");
  const { withPanelRoute } = await import("../lib/deploy/traefik-stack");
  const { startLinkAddressSync, stopLinkAddressSync } =
    await import("../lib/data/servers/link-addresses");
  const remote = agents.find((a) => a.id === "srv-e2e-remote")!;
  const self = agents.find((a) => a.id === "srv-e2e-self")!;
  const helloPair = async (id: string) => {
    const conn = await connectAgent(id);
    try {
      return (await conn.hello()).linkAddresses;
    } finally {
      conn.close();
    }
  };
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  const until = async (what: string, ok: () => Promise<boolean> | boolean) => {
    for (const end = Date.now() + 20_000; !(await ok()); await sleep(100))
      if (Date.now() > end) throw new Error(`never: ${what}`);
  };

  // Nothing listens on the discard port: only the fallback can bring the link back.
  const viaFallback = {
    primary: "http://127.0.0.1:9",
    fallback: `http://127.0.0.1:${door}`,
  };
  const before = currentLink(remote.id);
  const conn = await connectAgent(remote.id);
  const kept = await conn.setLinkAddresses(viaFallback);
  conn.close();
  if (!same(kept, viaFallback)) throw new Error(`kept ${JSON.stringify(kept)}`);
  if (!same(await helloPair(remote.id), viaFallback))
    throw new Error("Hello does not report the new pair");
  const saved = JSON.parse(
    readFileSync(join(remote.dir, "link-addresses.json"), "utf8"),
  );
  if (!same(saved, viaFallback))
    throw new Error(`saved ${JSON.stringify(saved)}`);
  if (currentLink(remote.id) !== before)
    throw new Error("a new pair ended the open link");
  before!.close(1001, "e2e: the panel restarts");
  await until("a link through the fallback", () => {
    const now = currentLink(remote.id);
    return !!now && now !== before;
  });
  console.log(
    `== srv-e2e-remote: took a new pair over its link, kept the link, relinked through the fallback ✓`,
  );

  // Agent 0's proxy routes the panel and a fallback name; the panel reads it there, over agent 0's link.
  const stack = withPanelRoute("services:\n  traefik:\n    image: traefik\n", {
    domain: "localhost",
    fallbackDomain: "127.0.0.1",
    https: false,
    certResolver: null,
    target: "http://deplo:3000",
  });
  mkdirSync(join(self.dir, "traefik"), { recursive: true });
  writeFileSync(join(self.dir, "traefik", "docker-compose.yml"), stack);
  const selfPair = await helloPair(self.id);
  startLinkAddressSync();
  try {
    const wanted = {
      primary: `http://localhost:${door}`,
      fallback: `http://127.0.0.1:${door}`,
    };
    await helloPair(remote.id); // any Hello the panel sees
    await until("the panel's pair on the remote server", async () =>
      same(await helloPair(remote.id), wanted),
    );
    if (!same(await helloPair(self.id), selfPair))
      throw new Error("the panel's own server was sent another pair");
    console.log(
      `== srv-e2e-remote: the panel sent ${wanted.primary} + ${wanted.fallback}; agent 0 kept ${selfPair?.primary} alone ✓`,
    );
  } finally {
    await stopLinkAddressSync();
  }
}

(process.argv.includes("--link") ? linkMain() : main()).then(
  () => process.exit(0),
  (e) => {
    console.error("\n❌ Part B e2e FAILED:", e);
    process.exit(1);
  },
);
