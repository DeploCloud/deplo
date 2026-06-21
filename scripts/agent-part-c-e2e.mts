/**
 * End-to-end smoke test for the server agent PART C (observability + files).
 * Drives the REAL agent over mTLS against real Docker: deploys a labelled
 * container, then exercises every Part C RPC the way the control plane will —
 * ListInstances, Exec (zero/non-zero/label-denied), ShellLabel, FollowLogs,
 * Attach, Metrics, and the full file CRUD incl. sandbox-escape rejection.
 *
 * The "remote" path is simulated by the LOCAL agent over loopback mTLS (the
 * sandbox has no second host); the wire contract + authz + sandbox are identical
 * to a real remote. Run with: npx tsx scripts/agent-part-c-e2e.mts
 *
 * Not part of `npm test` (needs Docker + the built binary).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DEPLO_SECRET ||= "e2e-agent-secret-aaaaaaaaaaaaaaaaaaaa";
const DATA = mkdtempSync(join(tmpdir(), "deplo-agent-c-e2e-"));
process.env.DEPLO_DATA_DIR = DATA;
process.env.DEPLO_AGENT_BIN = join(process.cwd(), "agent/bin/deplo-agent");
process.env.DEPLO_AGENT_ADDR = "127.0.0.1:19444"; // avoid clashing

const SLUG = "agent-c-e2e";
const NAME = `deplo-${SLUG}`;
const PROJECT_ID = "prj_c_e2e";

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

async function main() {
  const { connectAgent, agentPreflight } = await import("../lib/infra/agent-client");
  const { SourceKind, BuildKind } = await import("../lib/agent/gen/agent");

  console.log("== preflight ==");
  const hello = await agentPreflight("srv-local");
  if (!hello.dockerAvailable) throw new Error("agent reports docker unavailable");

  // Deploy a labelled, shell-bearing, running container so the console RPCs have
  // a real target. (Label is what assertOwned checks; busybox gives /bin/sh.)
  const ctxDir = mkdtempSync(join(tmpdir(), "deplo-c-ctx-"));
  writeFileSync(
    join(ctxDir, "Dockerfile"),
    ["FROM busybox:latest", `CMD ["sh","-c","while true; do sleep 1; done"]`].join("\n") + "\n",
  );
  const tar = await tarToBytes(ctxDir);
  const composeYaml = `services:
  ${NAME}:
    image: deplo/${SLUG}:e2e
    container_name: ${NAME}
    labels:
      deplo.project: ${PROJECT_ID}
    restart: unless-stopped
    networks:
      - deplo
networks:
  deplo:
    external: true
`;

  console.log("== deploy target container ==");
  {
    const conn = await connectAgent("srv-local");
    try {
      for await (const ev of conn.deploy({
        deployId: "dpl_c_e2e",
        slug: SLUG,
        projectId: PROJECT_ID,
        imageRef: `deplo/${SLUG}:e2e`,
        sourceKind: SourceKind.SOURCE_KIND_UPLOAD,
        buildKind: BuildKind.BUILD_KIND_DOCKERFILE,
        dockerfile: { dockerfilePath: "Dockerfile", contextPath: ".", targetStage: "", generated: false, generatedDockerfile: "" },
        composeYaml,
        env: {},
        readyTimeoutMs: 60000,
        contextTar: tar,
        pullImage: false,
        mounts: [],
      })) {
        if (ev.result && !ev.result.ready) throw new Error("deploy failed: " + ev.result.error);
      }
    } finally {
      conn.close();
    }
  }
  const running = (await sh("docker", ["inspect", "-f", "{{.State.Running}}", NAME])).out.trim() === "true";
  check("target container running", running);

  // ---- ListInstances ----
  console.log("== ListInstances ==");
  {
    const conn = await connectAgent("srv-local");
    try {
      const instances = await conn.listInstances(PROJECT_ID, SLUG, "");
      check("lists exactly the project container", instances.length === 1 && instances[0].name === NAME,
        JSON.stringify(instances.map((i) => i.name)));
      check("reports running + user/workdir", instances[0]?.running === true && instances[0]?.workdir !== "");
    } finally {
      conn.close();
    }
  }

  // ---- Exec ----
  console.log("== Exec ==");
  {
    const conn = await connectAgent("srv-local");
    try {
      const ok = await conn.exec(PROJECT_ID, NAME, "echo hello-c-e2e", `deplo/${SLUG}:e2e`);
      check("exec zero-exit returns stdout", ok.code === 0 && ok.stdout.includes("hello-c-e2e"), JSON.stringify(ok));
      const nz = await conn.exec(PROJECT_ID, NAME, "false", `deplo/${SLUG}:e2e`);
      check("exec non-zero exit is reported, not thrown", nz.code !== 0);
      // assertOwned negative: a wrong project_id must be PermissionDenied.
      let denied = false;
      try {
        await conn.exec("prj_WRONG", NAME, "echo nope", `deplo/${SLUG}:e2e`);
      } catch (e) {
        denied = /permission|denied/i.test(String(e));
      }
      check("exec with wrong project_id is denied (assertOwned)", denied);
    } finally {
      conn.close();
    }
  }

  // ---- ShellLabel ----
  console.log("== ShellLabel ==");
  {
    const conn = await connectAgent("srv-local");
    try {
      const label = await conn.shellLabel(PROJECT_ID, NAME, `deplo/${SLUG}:e2e`);
      check("shell label is /bin/sh for busybox", label === "/bin/sh", label);
    } finally {
      conn.close();
    }
  }

  // ---- FollowLogs ----
  console.log("== FollowLogs ==");
  {
    // Write a recognizable line to the container's stdout (PID1 of our container
    // just sleeps, so log a line via a side exec into its stdout is not visible;
    // instead run a short-lived labelled container that prints, and tail it).
    const logName = `deplo-${SLUG}-logger`;
    await sh("docker", ["rm", "-f", logName]);
    await sh("docker", ["run", "-d", "--name", logName, "--label", `deplo.project=${PROJECT_ID}`,
      "busybox:latest", "sh", "-c", "for i in 1 2 3; do echo LOGLINE-$i; sleep 0.3; done; sleep 5"]);
    await sleep(500);
    const conn = await connectAgent("srv-local");
    const handle = conn.followLogs(PROJECT_ID, logName, 100);
    let buf = "";
    handle.onData((c) => (buf += c.toString("utf8")));
    await sleep(1500);
    handle.close();
    conn.close();
    check("FollowLogs streamed the container output", buf.includes("LOGLINE-1") && buf.includes("LOGLINE-3"), JSON.stringify(buf));
    await sh("docker", ["rm", "-f", logName]);
  }

  // ---- Attach (non-tty pipe path) ----
  console.log("== Attach ==");
  {
    // A container reading stdin and echoing it back, attachable over pipes.
    const attName = `deplo-${SLUG}-att`;
    await sh("docker", ["rm", "-f", attName]);
    await sh("docker", ["run", "-d", "-i", "--name", attName, "--label", `deplo.project=${PROJECT_ID}`,
      "busybox:latest", "sh", "-c", "cat"]); // cat echoes stdin -> stdout
    await sleep(400);
    const conn = await connectAgent("srv-local");
    const handle = conn.attach(PROJECT_ID, attName, false, 80, 24);
    let out = "";
    handle.onData((c) => (out += c.toString("utf8")));
    await sleep(300);
    handle.write("ping-attach\n");
    await sleep(800);
    handle.close();
    conn.close();
    check("Attach echoed stdin back through the container", out.includes("ping-attach"), JSON.stringify(out));
    await sh("docker", ["rm", "-f", attName]);
  }

  // ---- Metrics ----
  console.log("== Metrics ==");
  {
    const conn = await connectAgent("srv-local");
    try {
      const m = await conn.metrics("");
      check("Metrics returns sane host data", m.cpuCores > 0 && Number(m.memTotal) > 0, JSON.stringify({ cores: m.cpuCores, mem: String(m.memTotal) }));
    } finally {
      conn.close();
    }
  }

  // ---- Files CRUD + sandbox ----
  console.log("== Files ==");
  {
    const conn = await connectAgent("srv-local");
    try {
      const w = await conn.writeFile(SLUG, "conf/app.yml", "key: value\n");
      check("WriteFile creates a nested file", w.path === "conf/app.yml" && w.kind === "file");
      const r = await conn.readFile(SLUG, "conf/app.yml");
      check("ReadFile returns the text", r.text === "key: value\n" && r.reason === null);
      const ls = await conn.listFiles(SLUG, "");
      check("ListFiles shows the conf dir", ls.some((e) => e.name === "conf" && e.kind === "dir"));
      const mv = await conn.renameFile(SLUG, "conf/app.yml", "conf/app2.yml");
      check("RenameFile moves within the sandbox", mv.path === "conf/app2.yml");
      const exists = await conn.filesExist(SLUG);
      check("FilesExist is true for the slug", exists === true);
      const del = await conn.deleteFile(SLUG, "conf/app2.yml");
      check("DeleteFile removes the file", del === true);

      // Sandbox: a traversal escape must be rejected (InvalidArgument).
      let escaped = false;
      try {
        await conn.readFile(SLUG, "../../../etc/hostname");
      } catch (e) {
        escaped = /escape|traversal|invalid/i.test(String(e));
      }
      check("Files traversal escape is rejected", escaped);
    } finally {
      conn.close();
    }
  }

  // Teardown.
  await sh("docker", ["rm", "-f", NAME]);
  rmSync(ctxDir, { recursive: true, force: true });
  rmSync(DATA, { recursive: true, force: true });
  killLocalAgent();

  console.log(`\nPart C E2E: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

/**
 * Kill the local agent the supervisor spawned. ensureLocalAgent pins the child
 * on globalThis; without this the agent outlives the script (stdio inherited),
 * orphaning the process and holding any piped stdout open. Belt-and-braces: also
 * SIGKILL by the e2e listen address.
 */
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

function tarToBytes(dir: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const c = spawn("tar", ["--format=ustar", "-cf", "-", "-C", dir, "."], { windowsHide: true });
    const chunks: Buffer[] = [];
    c.stdout.on("data", (d: Buffer) => chunks.push(d));
    c.on("error", reject);
    c.on("close", (code) => (code === 0 ? resolve(new Uint8Array(Buffer.concat(chunks))) : reject(new Error(`tar ${code}`))));
  });
}

main().catch((e) => {
  console.error("E2E ERROR:", e);
  killLocalAgent();
  process.exit(1);
});
