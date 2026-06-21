/**
 * End-to-end smoke test for the server agent (PLAN Part A). Drives the REAL
 * path against real Docker: the supervisor mints certs from the derived CA and
 * launches the agent binary over mTLS, the client dials it, and a Deploy streams
 * a tiny Dockerfile build + compose-up. Asserts the container comes up running,
 * then tears it down. Run with: npx tsx scripts/agent-e2e.mts
 *
 * Not part of `npm test` (it needs Docker + the built binary); it is the manual
 * proof that the contract works machine-to-machine, complementing the unit tests.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DEPLO_SECRET ||= "e2e-agent-secret-aaaaaaaaaaaaaaaaaaaa";
const DATA = mkdtempSync(join(tmpdir(), "deplo-agent-e2e-"));
process.env.DEPLO_DATA_DIR = DATA;
process.env.DEPLO_AGENT_BIN = join(process.cwd(), "agent/bin/deplo-agent");
process.env.DEPLO_AGENT_ADDR = "127.0.0.1:19443"; // avoid clashing with a real agent

const SLUG = "agent-e2e-demo";
const NAME = `deplo-${SLUG}`;

function sh(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { windowsHide: true });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

async function main() {
  const { connectAgent, agentPreflight } = await import("../lib/infra/agent-client");
  const { SourceKind, BuildKind } = await import("../lib/agent/gen/agent");

  console.log("== preflight (Hello over mTLS) ==");
  const hello = await agentPreflight("srv-local");
  console.log("  agent:", hello.agentVersion, "docker:", hello.dockerAvailable, hello.dockerVersion);
  if (!hello.dockerAvailable) throw new Error("agent reports docker unavailable");

  // A minimal Dockerfile build context, tar'd in memory (ustar, relative).
  const ctxDir = mkdtempSync(join(tmpdir(), "deplo-e2e-ctx-"));
  writeFileSync(
    join(ctxDir, "Dockerfile"),
    [
      "FROM busybox:latest",
      // A trivial long-running server on :3000 so the container stays running.
      `CMD ["sh","-c","while true; do echo hi | nc -l -p 3000 || sleep 1; done"]`,
    ].join("\n") + "\n",
  );
  const tar = await tarToBytes(ctxDir);

  // A rendered single-image compose, exactly as renderCompose would emit (no
  // routes needed for the e2e — we only assert the container runs).
  const composeYaml = `services:
  ${NAME}:
    image: deplo/${SLUG}:e2e
    container_name: ${NAME}
    restart: unless-stopped
    networks:
      - deplo
networks:
  deplo:
    external: true
`;

  console.log("== Deploy (build + compose up over mTLS) ==");
  const conn = await connectAgent("srv-local");
  let ready: boolean | null = null;
  try {
    for await (const ev of conn.deploy({
      deployId: "dpl_e2e",
      slug: SLUG,
      projectId: "prj_e2e",
      imageRef: `deplo/${SLUG}:e2e`,
      sourceKind: SourceKind.SOURCE_KIND_UPLOAD,
      buildKind: BuildKind.BUILD_KIND_DOCKERFILE,
      dockerfile: { dockerfilePath: "Dockerfile", contextPath: ".", targetStage: "", generated: false, generatedDockerfile: "" },
      composeYaml,
      env: {},
      readyTimeoutMs: 60000,
      contextTar: tar,
      pullImage: false,
    })) {
      if (ev.log) console.log(`  [${ev.log.level}] ${ev.log.text}`);
      if (ev.phase) console.log(`  -- phase ${ev.phase.phase}`);
      if (ev.result) {
        ready = ev.result.ready;
        if (ev.result.error) console.log("  result error:", ev.result.error);
      }
    }
  } finally {
    conn.close();
  }

  console.log("== verify container state ==");
  const ps = await sh("docker", ["inspect", "-f", "{{.State.Running}}", NAME]);
  const running = ps.out.trim() === "true";
  console.log(`  agent result.ready=${ready}  docker says running=${running}`);

  // Teardown.
  await sh("docker", ["rm", "-f", NAME]);
  rmSync(ctxDir, { recursive: true, force: true });
  rmSync(DATA, { recursive: true, force: true });

  if (ready && running) {
    console.log("\nE2E PASS ✅  the agent built + ran the deploy over mTLS");
    process.exit(0);
  }
  console.log("\nE2E FAIL ❌");
  process.exit(1);
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
  process.exit(1);
});
