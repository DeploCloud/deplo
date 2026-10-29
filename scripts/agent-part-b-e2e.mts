// node --require ./lib/test/server-only-shim.cjs --import tsx scripts/agent-part-b-e2e.mts [--traefik] [--idle[=ms]]
// DEPLO_AGENT_BIN names the agent build (a semver VERSION, or the agentMin gate refuses it). It needs no
// database and deploys nothing: real agents link into the real door, the only way in (ADR-0040).
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import net from "node:net";
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
    if (PROXIED.traefik || PROXIED.idleMs)
      await proxiedE2e(door, enroll, { volume, sha });
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

// An agent installed with a listen address, before the link: it links, and is told over its link to close its port for good.
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

// --traefik: a real Traefik routes the link as the panel's proxy does. --idle: a proxy that cuts
// a connection quiet for that long (100 s by default) sits in the way. Neither deploys anything.
const PROXIED = {
  traefik: process.argv.includes("--traefik"),
  idleMs: (() => {
    const flag = process.argv.find(
      (a) => a === "--idle" || a.startsWith("--idle="),
    );
    if (!flag) return 0;
    return Number(flag.split("=")[1] ?? 100_000);
  })(),
};
const E2E_NET = "agentlink-e2e";
const E2E_TRAEFIK = "agentlink-e2e-traefik";

async function freePort(host = "127.0.0.1"): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, host, r));
  const { port } = srv.address() as net.AddressInfo;
  await new Promise((r) => srv.close(r));
  return port;
}

/** A TCP hop to `target`; with idleMs, it cuts any connection quiet both ways that long, as a CDN does. */
async function tcpHop(
  host: string,
  target: { host: string; port: number },
  idleMs = 0,
): Promise<{ port: number; cuts: () => number; close: () => void }> {
  let cuts = 0;
  const sockets = new Set<net.Socket>();
  const srv = net.createServer((client) => {
    const upstream = net.connect(target.port, target.host);
    sockets.add(client).add(upstream);
    let last = Date.now();
    const touch = () => (last = Date.now());
    client.on("data", touch);
    upstream.on("data", touch);
    client.pipe(upstream).pipe(client);
    const timer = idleMs
      ? setInterval(() => {
          if (Date.now() - last < idleMs) return;
          cuts++;
          client.destroy();
          upstream.destroy();
        }, 1_000)
      : null;
    const end = () => {
      if (timer) clearInterval(timer);
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on("close", end).on("error", end);
    upstream.on("close", end).on("error", end);
  });
  await new Promise<void>((r) => srv.listen(0, host, r));
  return {
    port: (srv.address() as net.AddressInfo).port,
    cuts: () => cuts,
    close: () => {
      for (const s of sockets) s.destroy();
      srv.close();
    },
  };
}

/** Traefik on its own network, published on loopback, routing the link with the panel's own router. */
async function startTraefik(door: number): Promise<{
  http: number;
  https: number;
  stop: () => Promise<void>;
}> {
  const { withPanelRoute } = await import("../lib/deploy/traefik-stack");
  const { parse } = await import("yaml");
  const made = await sh("docker", ["network", "create", E2E_NET]);
  if (made.code !== 0) throw new Error(`network ${E2E_NET}: ${made.out}`);
  const dir = mkdtempSync(join(tmpdir(), "agentlink-traefik-"));
  let hop: Awaited<ReturnType<typeof tcpHop>> | null = null;
  const stop = async () => {
    await sh("docker", ["rm", "-f", E2E_TRAEFIK]);
    await sh("docker", ["network", "rm", E2E_NET]);
    hop?.close();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const gw = (
      await sh("docker", [
        "network",
        "inspect",
        E2E_NET,
        "-f",
        "{{range .IPAM.Config}}{{.Gateway}}{{end}}",
      ])
    ).out.trim();
    if (!gw) throw new Error(`no gateway on ${E2E_NET}`);
    // The door listens on loopback; the container reaches it on its network's gateway.
    hop = await tcpHop(gw, { host: "127.0.0.1", port: door });
    const stack = withPanelRoute(
      "services:\n  traefik:\n    image: traefik\n",
      {
        domain: "localhost",
        fallbackDomain: null,
        https: true,
        certResolver: null,
        target: `http://${gw}:3000`,
      },
    );
    const configs = (
      parse(stack) as { configs: Record<string, { content: string }> }
    ).configs;
    const file = Object.values(configs).find((c) =>
      c.content.includes("/api/agent/link"),
    )!.content;
    // The same routers; only the link service moves from :3001 to the hop in front of the door.
    writeFileSync(
      join(dir, "panel.yml"),
      file.replaceAll(`http://${gw}:3001`, `http://${gw}:${hop.port}`),
    );
    const [httpPort, httpsPort] = [await freePort(), await freePort()];
    const run = await sh("docker", [
      "run",
      "-d",
      "--name",
      E2E_TRAEFIK,
      "--network",
      E2E_NET,
      "-p",
      `127.0.0.1:${httpPort}:80`,
      "-p",
      `127.0.0.1:${httpsPort}:443`,
      "-v",
      `${dir}:/etc/traefik/dynamic:ro`,
      "traefik:v3.7",
      "--providers.file.directory=/etc/traefik/dynamic",
      "--entrypoints.web.address=:80",
      // The installer's redirect, aimed at the port published here instead of :443.
      `--entrypoints.web.http.redirections.entrypoint.to=:${httpsPort}`,
      "--entrypoints.web.http.redirections.entrypoint.scheme=https",
      "--entrypoints.web.http.redirections.entrypoint.priority=1",
      "--entrypoints.websecure.address=:443",
      "--entrypoints.web.transport.respondingtimeouts.readtimeout=0",
      "--entrypoints.websecure.transport.respondingtimeouts.readtimeout=0",
    ]);
    if (run.code !== 0) throw new Error(`traefik: ${run.out}`);
    for (const end = Date.now() + 20_000; ; await sleep(200)) {
      const probe = await sh("curl", [
        "-sk",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        `https://localhost:${httpsPort}${"/api/agent/link"}`,
      ]);
      // 426: the door itself answered a request that was no upgrade.
      if (probe.out === "426") break;
      if (Date.now() > end)
        throw new Error(`traefik never routed the link (${probe.out})`);
    }
    return { http: httpPort, https: httpsPort, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}

// An agent behind Traefik and/or an idle-cutting proxy: it follows :80's redirect, moves a large
// export through both TLS layers, and keeps one link through a silence longer than the proxy allows.
async function proxiedE2e(
  door: number,
  enroll: (id: string, ip: string, extra?: string[]) => Promise<E2eAgent>,
  data: { volume: string; sha: string },
) {
  const { connectAgent } = await import("../lib/infra/agent-client/connect");
  const { currentLink, waitForLink } =
    await import("../lib/infra/agent-link/registry");
  const id = "srv-e2e-proxied";
  const until = async (what: string, ok: () => boolean) => {
    for (const end = Date.now() + 30_000; !ok(); await sleep(100))
      if (Date.now() > end) throw new Error(`never: ${what}`);
  };
  const traefik = PROXIED.traefik ? await startTraefik(door) : null;
  let idle: Awaited<ReturnType<typeof tcpHop>> | null = null;
  try {
    if (PROXIED.idleMs)
      idle = await tcpHop(
        "127.0.0.1",
        { host: "127.0.0.1", port: traefik ? traefik.https : door },
        PROXIED.idleMs,
      );
    const primary = idle
      ? `${traefik ? "https" : "http"}://localhost:${idle.port}`
      : `http://localhost:${traefik!.http}`;

    await enroll(id, "198.51.100.9");
    const direct = await waitForLink(id, 20_000);
    if (!direct) throw new Error(`${id} never linked`);
    const conn = await connectAgent(id);
    await conn.setLinkAddresses({ primary, fallback: "" });
    conn.close();
    direct.close(1001, "e2e: the panel restarts");
    await until(`${id} relinking through ${primary}`, () => {
      const now = currentLink(id);
      return !!now && now !== direct;
    });
    const via = [
      traefik && !idle ? "Traefik's :80 redirect to https" : null,
      traefik ? "Traefik" : null,
      idle ? `a proxy that cuts ${PROXIED.idleMs / 1000} s of silence` : null,
    ].filter(Boolean);
    console.log(`== ${id}: linked through ${via.join(", ")} ✓`);

    const started = Date.now();
    const exp = await connectAgent(id);
    const chunks: Buffer[] = [];
    for await (const chunk of exp.exportVolume(data.volume)) chunks.push(chunk);
    exp.close();
    const gz = Buffer.concat(chunks);
    const blob = tarEntry(gunzipSync(gz), "blob");
    const got = blob && createHash("sha256").update(blob).digest("hex");
    if (got !== data.sha) throw new Error(`export through the proxy: ${got}`);
    const secs = (Date.now() - started) / 1000;
    console.log(
      `== volume export through it: ${(gz.length / 1048576).toFixed(1)} MiB in ${secs.toFixed(1)} s (${(gz.length / 1048576 / secs).toFixed(1)} MiB/s), byte-identical ✓`,
    );

    if (idle) {
      const link = currentLink(id);
      const quiet = PROXIED.idleMs + 15_000;
      console.log(`== ${id}: no call for ${quiet / 1000} s…`);
      await sleep(quiet);
      if (currentLink(id) !== link)
        throw new Error(`${id} lost its link in the silence`);
      if (idle.cuts() > 0)
        throw new Error(`the proxy cut ${idle.cuts()} links`);
      const after = await connectAgent(id);
      await after.hello();
      after.close();
      console.log(
        `== ${id}: one link through ${quiet / 1000} s of silence, the proxy cut nothing, Hello answers ✓`,
      );
    }
  } finally {
    idle?.close();
    await traefik?.stop();
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

linkMain().then(
  () => process.exit(0),
  (e) => {
    console.error("\n❌ agent link e2e FAILED:", e);
    process.exit(1);
  },
);
