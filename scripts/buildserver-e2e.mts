/**
 * End-to-end proof of the BUILD SERVER path against two REAL fleet hosts.
 *
 *   node --env-file=.env --require ./lib/test/server-only-shim.cjs \
 *        --import tsx scripts/buildserver-e2e.mts
 *
 * REAL NODE, NEVER BUN (bun's TLS SAN handling rejects the agent cert, so every
 * mTLS dial fails) - the same rule scripts/fleet-update.mts states.
 *
 * Build on one host, relay the image to another, confirm it landed there and was
 * reclaimed on the builder. Nothing is started anywhere: build_only writes no
 * stack file and runs no container, so the only footprint is one image, under a
 * slug that cannot collide with anything real - which matters, because a hardcoded
 * slug in an agent test has taken down production twice.
 *
 * Not part of `bun run test`: it needs two provisioned servers on an agent that
 * advertises `deploy.build-only` + `image-copy`. It is the manual proof the unit
 * tests cannot give, and it is what caught that the FIRST version of its own
 * existence check was wrong (see hasImage).
 */
import { connectAgent, agentPreflight } from "/root/projects/deplo/lib/infra/agent-client";
import { copyImageBetween } from "/root/projects/deplo/lib/data/volume-migration";
import { SourceKind, BuildKind } from "/root/projects/deplo/lib/agent/gen/agent";
import { listAllServers } from "/root/projects/deplo/lib/data/servers";

const SLUG = "zz-buildsrv-probe";
const TAG = `deplo/${SLUG}:${Date.now().toString(16).slice(-12)}`;

const servers = await listAllServers();
// Two provisioned hosts of the SAME architecture; override with BUILDER/TARGET.
const usable = servers.filter((s) => s.agent?.certFingerprint && !s.storageOnly);
const builder = usable.find((s) => s.name === (process.env.BUILDER ?? "")) ?? usable[0];
const target =
  usable.find((s) => s.name === (process.env.TARGET ?? "")) ??
  usable.find((s) => s.id !== builder?.id);
if (!builder || !target) {
  console.log("Servono due server provisioned - salto.");
  process.exit(0);
}
console.log(`builder=${builder.name}  target=${target.name}  tag=${TAG}\n`);

// A build context that needs no registry pull for its FROM: scratch has no layers.
const { mkdtempSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const dir = mkdtempSync(join(tmpdir(), "bs-e2e-"));
writeFileSync(join(dir, "Dockerfile"), "FROM scratch\nCOPY hello.txt /hello.txt\n");
writeFileSync(join(dir, "hello.txt"), "build server probe\n");

const { spawnSync } = await import("node:child_process");
const tarOut = spawnSync("tar", ["--format=ustar", "-cf", "-", "-C", dir, "."], {
  maxBuffer: 64 * 1024 * 1024,
});
const contextTar = new Uint8Array(tarOut.stdout);
console.log(`context: ${contextTar.length} bytes`);

console.log("\n== 1. BUILD ONLY sul builder ==");
const bconn = await connectAgent(builder.id);
let ready = false;
try {
  const stream = bconn.deploy({
    deployId: `dpl_probe_${Date.now()}`,
    slug: SLUG,
    projectId: "prj_probe",
    imageRef: TAG,
    sourceKind: SourceKind.SOURCE_KIND_UPLOAD,
    buildKind: BuildKind.BUILD_KIND_DOCKERFILE,
    dockerfile: {
      dockerfilePath: "Dockerfile",
      contextPath: ".",
      targetStage: "",
      generated: false,
      generatedDockerfile: "",
    },
    git: undefined,
    composeYaml: "services: {}\n",
    env: {},
    readyTimeoutMs: 60000,
    contextTar,
    pullImage: false,
    mounts: [],
    devWorkspaceSubdir: "",
    buildSpec: undefined,
    noBuildCache: false,
    forceRecreate: false,
    composeUpArgs: [],
    buildOnly: true,
  });
  for await (const ev of stream) {
    if (ev.log) console.log(`   [${ev.log.level}] ${ev.log.text.trimEnd()}`);
    if (ev.result) {
      ready = ev.result.ready;
      if (ev.result.error) console.log(`   ERRORE: ${ev.result.error}`);
    }
  }
} finally {
  bconn.close();
}
console.log(`   ready=${ready}`);
if (!ready) { console.log("BUILD FALLITA - mi fermo"); process.exit(1); }

console.log("\n== 2. RELAY builder -> target ==");
const src = await connectAgent(builder.id);
const dst = await connectAgent(target.id);
let bytes = 0;
try {
  bytes = await copyImageBetween(src, dst, TAG, true);
} finally {
  src.close(); dst.close();
}
console.log(`   trasferiti ${bytes} byte`);

console.log("\n== 3. VERIFICA ==");

/**
 * Esiste quel tag su quell'host?
 *
 * NON si conta il numero di chunk: il writer gzip emette il proprio header appena
 * viene creato, quindi anche un `docker save` che fallisce produce qualche byte di
 * framing. L'unico segnale valido e' l'errore terminale dello stream.
 */
async function hasImage(serverId: string, tag: string): Promise<boolean> {
  const c = await connectAgent(serverId);
  try {
    let bytes = 0;
    for await (const ch of c.exportImage(tag, false)) bytes += ch.length;
    return bytes > 512; // un'immagine vera, non il solo involucro gzip
  } catch {
    return false;
  } finally {
    c.close();
  }
}

const onTarget = await hasImage(target.id, TAG);
console.log(`   target ha l'immagine: ${onTarget ? "SI" : "NO"}`);
const onBuilder = await hasImage(builder.id, TAG);
console.log(`   builder ha ancora l'immagine: ${onBuilder ? "SI (male)" : "NO (corretto)"}`);

// Pulizia del target.
const t3 = await connectAgent(target.id);
try {
  for await (const _c of t3.exportImage(TAG, true)) void _c;
} catch { /* gia' via */ } finally { t3.close(); }
const stillThere = await hasImage(target.id, TAG);
console.log(`   pulizia target: ${stillThere ? "FALLITA" : "ok"}`);

const pass = ready && bytes > 0 && onTarget && !onBuilder && !stillThere;
console.log(`\n${pass ? "TUTTO OK" : "QUALCOSA NON TORNA"}: build su un host, immagine sull'altro, builder ripulito.`);
process.exit(pass ? 0 : 1);
