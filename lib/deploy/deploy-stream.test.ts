import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDeployStream, type AgentBuildPlan } from "./agent-deploy";
import { stackRpc } from "../infra/agent-client/stack-rpc";
import type { AgentChannel } from "../infra/agent-client/mtls-channel";
import type {
  DeployEvent,
  DeployRequest,
  DeployUpload,
} from "../agent/gen/agent";

const req = {
  deployId: "dep_1",
  network: "deplo-team-t",
  contextTar: new Uint8Array(0),
} as DeployRequest;

const result: DeployEvent = {
  seq: 1,
  result: { ready: true, commitSha: "", error: "" },
} as unknown as DeployEvent;

async function uploadPlan(): Promise<{ plan: AgentBuildPlan; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "deplo-up-"));
  await writeFile(join(dir, "index.html"), "<h1>hi</h1>");
  return {
    dir,
    plan: { kind: "dockerfile", buildDir: dir, build: {} as never },
  };
}

function recordingConn() {
  const calls: { method: string; req: DeployRequest; chunks: Buffer[] }[] = [];
  return {
    calls,
    conn: {
      deploy(r: DeployRequest) {
        calls.push({ method: "deploy", req: r, chunks: [] });
        return (async function* () {
          yield result;
        })();
      },
      deployStream(r: DeployRequest, context: AsyncIterable<Buffer>) {
        const entry = {
          method: "deployStream",
          req: r,
          chunks: [] as Buffer[],
        };
        calls.push(entry);
        return (async function* () {
          for await (const c of context) entry.chunks.push(c);
          yield result;
        })();
      },
    },
  };
}

async function drain(gen: AsyncGenerator<DeployEvent>): Promise<number> {
  let n = 0;
  while (!(await gen.next()).done) n++;
  return n;
}

test("an agent with deploy.context_stream gets the build folder in chunks", async () => {
  const { plan, dir } = await uploadPlan();
  try {
    const { conn, calls } = recordingConn();
    await drain(openDeployStream(conn, req, plan, ["deploy.context_stream"]));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "deployStream");
    assert.equal(calls[0].req.contextTar.length, 0);
    assert.ok(Buffer.concat(calls[0].chunks).includes("<h1>hi</h1>"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an older agent still gets the whole archive inline", async () => {
  const { plan, dir } = await uploadPlan();
  try {
    const { conn, calls } = recordingConn();
    await drain(openDeployStream(conn, req, plan, []));
    assert.equal(calls[0].method, "deploy");
    assert.ok(
      Buffer.from(calls[0].req.contextTar).includes("<h1>hi</h1>"),
      "the fallback inlines the tar",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a plan with no build folder never streams", async () => {
  const { conn, calls } = recordingConn();
  await drain(
    openDeployStream(conn, req, { kind: "image", image: "nginx", pull: true }, [
      "deploy.context_stream",
    ]),
  );
  assert.equal(calls[0].method, "deploy");
});

class FakeDuplex extends EventEmitter {
  written: DeployUpload[] = [];
  ended = false;
  cancelled = false;
  write(v: DeployUpload): boolean {
    this.written.push(v);
    return true;
  }
  end(): void {
    this.ended = true;
  }
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.emit("error", Object.assign(new Error("Cancelled"), { code: 1 }));
  }
  pause(): this {
    return this;
  }
  resume(): this {
    return this;
  }
}

function fakeChannel(call: FakeDuplex): AgentChannel {
  return {
    client: { deployStream: () => call },
    assertNetworkCapable: async () => {},
  } as unknown as AgentChannel;
}

const settle = () => new Promise((r) => setImmediate(r));

test("deployStream sends the request first, then the chunks, then half-closes", async () => {
  const call = new FakeDuplex();
  async function* chunks() {
    yield Buffer.from("aa");
    yield Buffer.from("bb");
  }
  const gen = stackRpc(fakeChannel(call)).deployStream(
    { ...req, contextTar: new Uint8Array([1, 2, 3]) },
    chunks(),
  );
  const first = gen.next();
  await settle();
  await settle();
  assert.equal(call.written.length, 3);
  assert.equal(call.written[0].request?.deployId, "dep_1");
  assert.equal(
    call.written[0].request?.contextTar.length,
    0,
    "the context never rides inline on the stream",
  );
  assert.deepEqual(
    call.written.slice(1).map((f) => Buffer.from(f.contextChunk!).toString()),
    ["aa", "bb"],
  );
  assert.equal(call.ended, true);
  call.emit("data", result);
  call.emit("end");
  assert.deepEqual((await first).value, result);
  assert.equal((await gen.next()).done, true);
});

test("returning early cancels the call and stops reading the build folder", async () => {
  const call = new FakeDuplex();
  let closed = false;
  let release: () => void = () => {};
  async function* chunks() {
    try {
      while (true) {
        yield Buffer.from("x");
        await new Promise<void>((r) => (release = r));
      }
    } finally {
      closed = true;
    }
  }
  const gen = stackRpc(fakeChannel(call)).deployStream(req, chunks());
  const first = gen.next();
  await settle();
  call.emit("data", result);
  await first;
  await gen.return(undefined);
  assert.equal(call.cancelled, true, "the call is cancelled");
  release();
  await settle();
  await settle();
  assert.equal(closed, true, "the tar producer is closed");
});

test("an upload failure surfaces its own error, not the cancel", async () => {
  const call = new FakeDuplex();
  async function* chunks(): AsyncGenerator<Buffer> {
    throw new Error("tar exited 2 while archiving build context");
  }
  const gen = stackRpc(fakeChannel(call)).deployStream(req, chunks());
  await assert.rejects(gen.next(), /tar exited 2/);
  assert.equal(call.cancelled, true);
});
