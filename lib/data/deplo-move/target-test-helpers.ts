import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import {
  MOVE_PROTOCOL,
  type DumpFrame,
  type MoveHello,
  type MoveServerSummary,
  type MoveStep,
  type MoveWorkloadInfo,
} from "../../deplo-move/protocol";
import { schemaTag } from "../../deplo-move/schema-tag";
import type { AgentConnection } from "../../infra/agent-client/connection";
import type { FetchLike } from "../../migration/transport";

export const OLD = "https://old.deplo.test";
export const NEW = "https://new.deplo.test";
export const SELF_IP = "192.0.2.200";
export const MOVE_CODE = "dmove_test-code";

export function summary(
  over: Partial<MoveServerSummary> & { id: string },
): MoveServerSummary {
  return {
    name: over.id,
    address: "198.51.100.10",
    port: 9443,
    role: "workloads",
    isPanelHost: false,
    enrolled: true,
    reachable: true,
    agentVersion: "0.5.0",
    apps: 0,
    databases: 0,
    ...over,
  };
}

export function helloOf(over: Partial<MoveHello> = {}): MoveHello {
  return {
    protocol: MOVE_PROTOCOL,
    version: "0.5.0",
    schema: schemaTag(),
    instance: "old-instance-fingerprint",
    panelUrl: OLD,
    state: "bound",
    counts: { teams: 2, users: 2, apps: 1, databases: 0, servers: 2 },
    servers: [],
    ...over,
  };
}

export function workloadInfo(
  over: Partial<MoveWorkloadInfo> & Pick<MoveWorkloadInfo, "kind" | "id">,
): MoveWorkloadInfo {
  return {
    name: over.id,
    slug: over.id,
    serverId: "srv_web",
    running: true,
    volumes: [],
    files: false,
    hostPaths: [],
    image: null,
    upload: null,
    ...over,
  };
}

// A real .tar.gz with one file in it: the copy refuses an archive with no entries.
export function tarGz(name: string, content: string): Buffer {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "latin1");
  header.write("0000644\0", 100, "latin1");
  header.write("0000000\0", 108, "latin1");
  header.write("0000000\0", 116, "latin1");
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  header.write("00000000000\0", 136, "latin1");
  header.write("        ", 148, "latin1");
  header.write("0", 156, "latin1");
  header.write("ustar\0", 257, "latin1");
  header.write("00", 263, "latin1");
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return gzipSync(Buffer.concat([header, body, pad, Buffer.alloc(1024)]));
}

// Frames for a dump the stub restorer reads; the bytes only have to be a valid stream.
export function dumpOf(tables: Record<string, Record<string, unknown>[]>) {
  const frames: DumpFrame[] = [
    {
      kind: "begin",
      protocol: MOVE_PROTOCOL,
      schema: schemaTag(),
      tables: Object.keys(tables),
    },
    ...Object.entries(tables).map(([table, rows]): DumpFrame => ({
      kind: "rows",
      table,
      rows,
      unreadable: [],
    })),
    {
      kind: "end",
      rows: Object.values(tables).reduce((n, r) => n + r.length, 0),
      unreadable: 0,
    },
  ];
  return frames.map((f) => JSON.stringify(f));
}

async function drain(chunks: AsyncIterable<Buffer>): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const c of chunks) out.push(Buffer.from(c));
  return Buffer.concat(out);
}

// Every server agent here: what each was asked to do, in order, as `<action>:<server>:<what>`.
export function fakeAgents() {
  const calls: string[] = [];
  const received = new Map<string, Buffer>();
  // Stacks torn down, so a teardown that checks finds nothing left.
  const gone = new Set<string>();
  const failing = new Map<string, string>();
  const refuse = (call: string) => {
    for (const [prefix, error] of failing)
      if (call.startsWith(prefix)) return { ok: false, error };
    return null;
  };
  const connector = async (serverId: string): Promise<AgentConnection> => {
    const record = (action: string, what: string) => {
      const call = `${action}:${serverId}:${what}`;
      calls.push(call);
      return refuse(call);
    };
    const imported = async (
      action: string,
      what: string,
      chunks: AsyncIterable<Buffer>,
    ) => {
      const bytes = await drain(chunks);
      const refused = record(action, what);
      if (refused) return { ...refused, bytesWritten: 0, sha256: "" };
      received.set(`${action}:${serverId}:${what}`, bytes);
      return {
        ok: true,
        error: "",
        bytesWritten: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        dropped: { links: 0, special: 0, names: [] },
      };
    };
    return {
      hello: async () => ({ capabilities: [], agentVersion: "0.5.0" }),
      close() {},
      reroute: async (req: { slug: string }) => {
        gone.delete(req.slug);
        return record("reroute", req.slug) ?? { ok: true, error: "" };
      },
      stopStack: async (slug: string) =>
        record("stop", slug) ?? { ok: true, error: "" },
      startStack: async (slug: string) =>
        record("start", slug) ?? { ok: true, error: "" },
      destroyStack: async (slug: string) => {
        gone.add(slug);
        return record("destroy", slug) ?? { ok: true, error: "" };
      },
      readStack: async () => ({ exists: true, yaml: "" }),
      importVolume: (
        name: string,
        _wipe: boolean,
        chunks: AsyncIterable<Buffer>,
      ) => imported("volume", name, chunks),
      importHostPath: (
        path: string,
        _wipe: boolean,
        chunks: AsyncIterable<Buffer>,
      ) => imported("hostpath", path, chunks),
      importFiles: (
        slug: string,
        _wipe: boolean,
        chunks: AsyncIterable<Buffer>,
      ) => imported("files", slug, chunks),
      importImage: (ref: string, chunks: AsyncIterable<Buffer>) =>
        imported("image", ref, chunks),
      listInstances: async (_id: string, slug: string) =>
        gone.has(slug)
          ? []
          : [
              {
                name: `deplo-${slug}`,
                service: slug,
                image: "postgres:16",
                running: true,
                exposed: false,
                user: "",
                workdir: "",
                openStdin: false,
                tty: false,
                state: "running",
                health: "healthy",
              },
            ],
      exec: async () => ({
        stdout: "3\n",
        stderr: "",
        code: 0,
        rawMode: false,
      }),
    } as unknown as AgentConnection;
  };
  return { calls, received, failing, connector };
}

type Failure = {
  status: number;
  error: string;
  // How many calls fail before the step starts answering; unset fails every time.
  times?: number;
  // Only calls naming this workload fail.
  id?: string;
};

export interface FakeOldDeplo {
  hello: MoveHello;
  dump: string[];
  workloads: Record<string, MoveWorkloadInfo>;
  // Raw bytes each data step streams, by `<step>:<what>`.
  data: Record<string, Buffer>;
  calls: { step: string; body: Record<string, unknown>; headers: Headers }[];
  fail: Partial<Record<MoveStep, Failure>>;
  // What is paused there right now, by workload id.
  paused: Set<string>;
  // Workloads whose lease lapses before the copy resumes them: the sweep already started them again.
  lapsed: Set<string>;
  fetch: FetchLike;
}

function streamOf(bytes: Uint8Array, size = 7): ReadableStream<Uint8Array> {
  // Cut at odd offsets, so a frame and a multi-byte character straddle chunks.
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size)
    chunks.push(bytes.slice(i, i + size));
  return new ReadableStream({
    pull(controller) {
      const next = chunks.shift();
      if (next) controller.enqueue(next);
      else controller.close();
    },
  });
}

function dataKey(step: string, body: Record<string, unknown>): string {
  const what =
    step === "volume"
      ? body.volume
      : step === "hostpath"
        ? body.path
        : step === "image"
          ? body.imageRef
          : body.id;
  return `${step}:${String(what)}`;
}

export function fakeOldDeplo(
  init: {
    hello?: MoveHello;
    dump?: string[];
    workloads?: MoveWorkloadInfo[];
    data?: Record<string, Buffer>;
  } = {},
): FakeOldDeplo {
  const fake: FakeOldDeplo = {
    hello: init.hello ?? helloOf(),
    dump: init.dump ?? dumpOf({}),
    workloads: Object.fromEntries((init.workloads ?? []).map((w) => [w.id, w])),
    data: init.data ?? {},
    calls: [],
    fail: {},
    paused: new Set(),
    lapsed: new Set(),
    fetch: async (input, reqInit) => {
      const prefix = `${OLD}/api/deplo-move/`;
      if (!input.startsWith(prefix))
        throw Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ENOTFOUND" },
        });
      const step = input.slice(prefix.length) as MoveStep;
      const body = JSON.parse(String(reqInit?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      fake.calls.push({ step, body, headers: new Headers(reqInit?.headers) });
      const f = fake.fail[step];
      if (f && (!f.id || f.id === body.id)) {
        if (f.times === undefined || f.times > 0) {
          if (f.times !== undefined) f.times -= 1;
          return Response.json({ error: f.error }, { status: f.status });
        }
      }
      const id = String(body.id ?? "");
      switch (step) {
        case "hello":
          return Response.json(fake.hello);
        case "dump":
          return new Response(
            streamOf(
              new TextEncoder().encode(fake.dump.map((l) => `${l}\n`).join("")),
            ),
            { headers: { "Content-Type": "application/x-ndjson" } },
          );
        case "workload": {
          const w = fake.workloads[id];
          return w
            ? Response.json(w)
            : Response.json({ error: "Not found" }, { status: 404 });
        }
        case "pause":
          fake.paused.add(id);
          return Response.json({
            leaseUntil: new Date(Date.now() + 120_000).toISOString(),
            wasRunning: fake.workloads[id]?.running ?? false,
          });
        case "resume":
          fake.paused.delete(id);
          return Response.json({ resumed: !fake.lapsed.has(id) });
        case "volume":
        case "hostpath":
        case "files":
        case "image":
        case "upload": {
          const bytes = fake.data[dataKey(step, body)];
          if (!bytes)
            return Response.json({ error: "Not found" }, { status: 404 });
          return new Response(streamOf(bytes, 97), {
            headers:
              step === "upload"
                ? { "x-deplo-move-filename": encodeURIComponent("site.tar.gz") }
                : {},
          });
        }
        default:
          return Response.json({ ok: true });
      }
    },
  };
  return fake;
}

// Each call as `<step>` or `<step>:<workload id>`.
export function stepsCalled(fake: FakeOldDeplo): string[] {
  return fake.calls.map((c) =>
    c.body.id ? `${c.step}:${String(c.body.id)}` : c.step,
  );
}
