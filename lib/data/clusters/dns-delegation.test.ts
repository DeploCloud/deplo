import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import net from "node:net";

import {
  decodeAnswer,
  encodeAnswer,
  encodeQuery,
  QTYPE,
  type QType,
} from "../../dns-wire";
import {
  askNameServer,
  checkDelegation,
  type DelegationDeps,
} from "./dns-delegation";

// ADR-0049: the check that a zone is delegated to its cluster, against fake name servers on loopback.

type Reply = Parameters<typeof encodeAnswer>[2] & { tc?: boolean };
type Book = Map<string, Reply | "silent">;

/** A name server on a loopback port answering from `book`, keyed "name TYPE"; over TCP too. */
function fakeServer(book: Book) {
  const udp = dgram.createSocket("udp4");
  const answer = (msg: Buffer, tcp: boolean): Buffer | null => {
    const id = msg.readUInt16BE(0);
    let at = 12;
    const labels: string[] = [];
    while (msg[at] !== 0) {
      labels.push(msg.toString("ascii", at + 1, at + 1 + msg[at]));
      at += 1 + msg[at];
    }
    const type = (Object.keys(QTYPE) as QType[]).find(
      (k) => QTYPE[k] === msg.readUInt16BE(at + 1),
    )!;
    const name = labels.join(".");
    const r =
      book.get(`${name} ${type}${tcp ? " tcp" : ""}`) ??
      book.get(`${name} ${type}`);
    if (r === "silent") return null;
    const out = encodeAnswer(id, { name, type }, r ?? { rcode: 5 });
    if (r?.tc) out.writeUInt16BE(out.readUInt16BE(2) | 0x0200, 2);
    return out;
  };
  udp.on("message", (msg, from) => {
    const a = answer(msg, false);
    if (a) udp.send(a, from.port, from.address);
  });
  const tcp = net.createServer((c) => {
    c.once("data", (d) => {
      const a = answer(d.subarray(2), true);
      if (!a) return void c.destroy();
      const len = Buffer.alloc(2);
      len.writeUInt16BE(a.length);
      c.end(Buffer.concat([len, a]));
    });
  });
  return {
    async start(): Promise<number> {
      await new Promise<void>((r) => udp.bind(0, "127.0.0.1", r));
      const port = udp.address().port;
      await new Promise<void>((r) => tcp.listen(port, "127.0.0.1", r));
      return port;
    },
    close() {
      udp.close();
      tcp.close();
    },
  };
}

const book: Book = new Map();
const server = fakeServer(book);
let port = 0;
before(async () => {
  port = await server.start();
});
after(() => server.close());

const deps = (parent: string | null = "example.com"): DelegationDeps => ({
  parentOf: async () =>
    parent ? { zone: parent, servers: ["127.0.0.1"] } : null,
  ask: (s, name, type) => askNameServer(s, name, type, port),
});

const EXPECTED = [
  { name: "ns1.go.example.com", v4: ["203.0.113.10"], v6: ["2001:db8::10"] },
  { name: "ns2.go.example.com", v4: ["203.0.113.11"], v6: [] },
];

/** What the parent says for go.example.com, and the cluster's own answer for its SOA. */
function delegated(over: Partial<Reply> = {}) {
  book.clear();
  book.set("go.example.com NS", {
    authority: [
      { name: "go.example.com", type: "NS", data: "ns1.go.example.com" },
      { name: "go.example.com", type: "NS", data: "ns2.go.example.com" },
    ],
    additional: [
      { name: "ns1.go.example.com", type: "A", data: "203.0.113.10" },
      { name: "ns1.go.example.com", type: "AAAA", data: "2001:db8::10" },
      { name: "ns2.go.example.com", type: "A", data: "203.0.113.11" },
    ],
    ...over,
  });
  book.set("go.example.com DS", { authority: [] });
  // The name servers' addresses are not this test's loopback: their answer is asked of the same fake, by name.
  book.set("go.example.com SOA", {
    authoritative: true,
    answer: [
      { name: "go.example.com", type: "SOA", data: "ns1.go.example.com" },
    ],
  });
}

const askAll: (d: DelegationDeps) => DelegationDeps = (d) => ({
  ...d,
  // Every name server lives at the fake: the check's question to "203.0.113.10" goes to loopback.
  ask: (_s, name, type) => d.ask("127.0.0.1", name, type),
});

test("a zone delegated with every NS record and its glue, and no DS", async () => {
  delegated();
  const c = await checkDelegation("go.example.com", EXPECTED, askAll(deps()));
  assert.deepEqual(c.problems, []);
  assert.equal(c.delegated, true);
  assert.equal(c.parent, "example.com");
  assert.deepEqual(
    c.nameServers.map((n) => [n.name, n.address, n.answers]),
    [
      ["ns1.go.example.com", "203.0.113.10", true],
      ["ns2.go.example.com", "203.0.113.11", true],
    ],
  );
});

test("missing glue, a stray name server and a stray address are each one record to fix", async () => {
  delegated({
    authority: [
      { name: "go.example.com", type: "NS", data: "ns1.go.example.com" },
      { name: "go.example.com", type: "NS", data: "ns.other-host.net" },
    ],
    additional: [
      { name: "ns1.go.example.com", type: "A", data: "203.0.113.10" },
      { name: "ns1.go.example.com", type: "A", data: "198.51.100.1" },
    ],
  });
  const c = await checkDelegation("go.example.com", EXPECTED, askAll(deps()));
  assert.equal(c.delegated, false);
  assert.deepEqual(c.problems.sort(), [
    "Add the A record ns2.go.example.com → 203.0.113.11.",
    "Add the AAAA record ns1.go.example.com → 2001:db8::10.",
    "Add the NS record go.example.com → ns2.go.example.com.",
    "go.example.com also names ns.other-host.net as a name server: remove that NS record.",
    "ns1.go.example.com also points at 198.51.100.1: remove that record.",
  ]);
});

test("a stray DS record would make every resolver refuse the unsigned zone", async () => {
  delegated();
  book.set("go.example.com DS", {
    answer: [{ name: "go.example.com", type: "NS", data: "x" }],
  });
  // A DS answer of the wrong type is not a DS; the real one is.
  assert.equal(
    (await checkDelegation("go.example.com", EXPECTED, askAll(deps())))
      .delegated,
    true,
  );
  const ds = encodeAnswer(
    1,
    { name: "go.example.com", type: "DS" },
    { answer: [] },
  );
  assert.equal(decodeAnswer(ds).answer.length, 0);
  book.set("go.example.com DS", {
    answer: [
      { name: "go.example.com", type: "DS" as QType, data: "go.example.com" },
    ],
  });
  const c = await checkDelegation("go.example.com", EXPECTED, askAll(deps()));
  assert.equal(c.delegated, false);
  assert.match(c.problems.join(" "), /Remove the DS record of go.example.com/);
});

test("not delegated at all, and a parent nobody can find", async () => {
  delegated({
    authority: [{ name: "example.com", type: "SOA", data: "ns.example.com" }],
    additional: [],
  });
  const c = await checkDelegation("go.example.com", EXPECTED, askAll(deps()));
  assert.equal(c.delegated, false);
  assert.deepEqual(c.problems, [
    "go.example.com is not delegated yet: add its NS records.",
  ]);
  const none = await checkDelegation(
    "go.example.com",
    EXPECTED,
    askAll(deps(null)),
  );
  assert.equal(none.delegated, false);
  assert.match(none.problems[0], /could not find who answers/);
});

test("a name server that does not answer is said, apart from the delegation", async () => {
  delegated();
  book.set("go.example.com SOA", "silent");
  const c = await checkDelegation("go.example.com", EXPECTED, askAll(deps()));
  assert.equal(c.delegated, true);
  assert.deepEqual(
    c.nameServers.map((n) => n.answers),
    [false, false],
  );
});

test("a truncated answer is asked again over TCP", async () => {
  book.clear();
  // The UDP answer says it is cut short; TCP has the whole one.
  book.set("big.example.com A", { tc: true });
  book.set("big.example.com A tcp", {
    answer: [{ name: "big.example.com", type: "A", data: "203.0.113.1" }],
  });
  const a = await askNameServer("127.0.0.1", "big.example.com", "A", port);
  assert.deepEqual(
    a.answer.map((r) => r.data),
    ["203.0.113.1"],
  );
});

test("the wire codec reads compressed names, IPv6 and refuses a message that runs short", () => {
  const q = encodeQuery(42, "go.example.com", "NS");
  assert.equal(q.readUInt16BE(0), 42);
  assert.equal(q.readUInt16BE(2) & 0x0100, 0, "recursion is never asked for");
  const a = encodeAnswer(
    9,
    { name: "go.example.com", type: "NS" },
    {
      authoritative: true,
      answer: [
        { name: "go.example.com", type: "AAAA", data: "2001:db8:0:0:0:0:0:1" },
      ],
    },
  );
  const d = decodeAnswer(a);
  assert.equal(d.authoritative, true);
  assert.equal(d.answer[0].data, "2001:db8::1");
  // A pointer back to the question's name, as real servers compress.
  const head = Buffer.from(
    encodeAnswer(1, { name: "x.example.com", type: "A" }, {}),
  );
  head.writeUInt16BE(1, 6);
  const rr = Buffer.from([
    0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 192, 0, 2, 1,
  ]);
  const packed = decodeAnswer(Buffer.concat([head, rr]));
  assert.deepEqual(
    [packed.answer[0].name, packed.answer[0].data],
    ["x.example.com", "192.0.2.1"],
  );
  assert.throws(() => decodeAnswer(Buffer.concat([head, rr.subarray(0, 8)])));
  assert.throws(() => decodeAnswer(Buffer.from([0, 1, 2])));
  const loop = Buffer.concat([head.subarray(0, 12), Buffer.from([0xc0, 12])]);
  loop.writeUInt16BE(1, 4);
  loop.writeUInt16BE(0, 6);
  assert.throws(() => decodeAnswer(loop));
});
