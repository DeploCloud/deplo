import { webcrypto } from "node:crypto";

import * as x509 from "@peculiar/x509";
import { eq, sql } from "drizzle-orm";

import { certFingerprint } from "../../agent/pki";
import { getDb } from "../../db/client";
import { schema } from "../../db/schema";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import {
  MOVE_PROTOCOL,
  type DumpFrame,
  type MoveHello,
  type MoveServerSummary,
  type MoveStep,
} from "../../deplo-move/protocol";
import { schemaTag } from "../../deplo-move/schema-tag";
import type { AgentConnection } from "../../infra/agent-client/connection";
import type { FetchLike } from "../../migration/transport";

export const OLD = "https://old.deplo.test";
export const NEW = "https://new.deplo.test";
export const SELF_IP = "192.0.2.200";
export const MOVE_CODE = "dmove_test-code";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

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
    canHandOver: true,
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

// Frames as the stub restorer reads them: drizzle-shaped rows keyed by the schema export name.
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

// Stands in for the copy engine: the target's own accounts go, the old Deplo's rows come in.
export async function stubRestore(
  lines: AsyncIterable<string>,
): Promise<{ rows: number; unreadable: number }> {
  const db = getDb();
  let rows = 0;
  await db.transaction(async (tx) => {
    await tx.execute(
      sql.raw(
        "truncate table memberships, membership_capabilities, users, teams cascade",
      ),
    );
    for await (const line of lines) {
      const f = JSON.parse(line) as DumpFrame;
      if (f.kind !== "rows" || f.rows.length === 0) continue;
      const table = schema[f.table as keyof typeof schema];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await tx.insert(table as any).values(f.rows as any);
      rows += f.rows.length;
    }
  });
  return { rows, unreadable: 0 };
}

export async function makeCsr(): Promise<string> {
  const keys = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: "CN=deplo-agent",
    keys,
    signingAlgorithm: { name: "Ed25519" },
  });
  return csr.toString("pem");
}

// Signed by another Deplo's CA: every Deplo names its CA the same, only the key differs.
export async function foreignAgentCert(): Promise<string> {
  const alg = { name: "Ed25519" };
  const keys = async () =>
    (await webcrypto.subtle.generateKey(alg, true, [
      "sign",
      "verify",
    ])) as unknown as CryptoKeyPair;
  const [ca, leaf] = [await keys(), await keys()];
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: "02",
    subject: "CN=deplo-agent",
    issuer: "CN=Deplo Agent CA",
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 86_400_000),
    signingKey: ca.privateKey,
    publicKey: leaf.publicKey,
    signingAlgorithm: alg,
  });
  return cert.toString("pem");
}

// Each agent answers whoever pins the certificate it was last told to install, like the real hot-swap.
export function fakeAgents() {
  const installed = new Map<string, string>();
  const unreachable = new Set<string>();
  const dialed: string[] = [];
  const connector = async (serverId: string): Promise<AgentConnection> => {
    dialed.push(serverId);
    const [row] = await getDb()
      .select({ fp: serversTable.agentCertFingerprint })
      .from(serversTable)
      .where(eq(serversTable.id, serverId));
    const answers =
      !unreachable.has(serverId) &&
      !!row?.fp &&
      installed.get(serverId) === row.fp;
    return {
      hello: async () => {
        if (!answers) throw new Error(`${serverId} refused the handshake`);
        return { capabilities: ["cert-renewal"], agentVersion: "0.5.0" };
      },
      close() {},
    } as unknown as AgentConnection;
  };
  return { installed, unreachable, dialed, connector };
}

type Failure = {
  status: number;
  error: string;
  handedOver?: boolean;
  // How many calls fail before the step starts answering; unset fails every time.
  times?: number;
  serverId?: string;
  // An install that reached the agent but whose answer was lost.
  applied?: boolean;
};

export interface FakeOldDeplo {
  hello: MoveHello;
  dump: string[];
  calls: { step: string; body: Record<string, unknown>; headers: Headers }[];
  fail: Partial<Record<MoveStep, Failure>>;
  fetch: FetchLike;
}

function streamOf(lines: string[]): ReadableStream<Uint8Array> {
  // Cut at odd offsets, so a frame and a multi-byte character straddle chunks.
  const bytes = new TextEncoder().encode(lines.map((l) => `${l}\n`).join(""));
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.slice(i, i + 7));
  return new ReadableStream({
    pull(controller) {
      const next = chunks.shift();
      if (next) controller.enqueue(next);
      else controller.close();
    },
  });
}

export function fakeOldDeplo(
  agents: ReturnType<typeof fakeAgents>,
  init: { hello?: MoveHello; dump?: string[] } = {},
): FakeOldDeplo {
  const fake: FakeOldDeplo = {
    hello: init.hello ?? helloOf(),
    dump: init.dump ?? [],
    calls: [],
    fail: {},
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
      if (f && (!f.serverId || f.serverId === body.serverId)) {
        if (f.times === undefined || f.times > 0) {
          if (f.times !== undefined) f.times -= 1;
          if (f.applied && step === "install")
            agents.installed.set(
              String(body.serverId),
              await certFingerprint(String(body.certPem)),
            );
          return Response.json(
            f.handedOver
              ? { error: f.error, handedOver: true }
              : { error: f.error },
            { status: f.status },
          );
        }
      }
      switch (step) {
        case "hello":
          return Response.json(fake.hello);
        case "dump":
          return new Response(streamOf(fake.dump), {
            headers: { "Content-Type": "application/x-ndjson" },
          });
        case "csr":
          return Response.json({ csrPem: await makeCsr() });
        case "install":
          agents.installed.set(
            String(body.serverId),
            await certFingerprint(String(body.certPem)),
          );
          return Response.json({ ok: true });
        default:
          return Response.json({ ok: true });
      }
    },
  };
  return fake;
}

export function stepsCalled(fake: FakeOldDeplo): string[] {
  return fake.calls.map((c) =>
    c.body.serverId ? `${c.step}:${String(c.body.serverId)}` : c.step,
  );
}
