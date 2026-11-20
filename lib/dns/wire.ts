// The few DNS messages Deplo itself sends: one question to one name server, never recursive (ADR-0049's check of a
// delegation). Encodes a query and decodes the answer's records; anything it does not read is skipped.

export const QTYPE = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  AAAA: 28,
  DS: 43,
} as const;
export type QType = keyof typeof QTYPE;

export type WireRecord = {
  name: string;
  type: number;
  ttl: number;
  data: string;
};

export type WireAnswer = {
  id: number;
  rcode: number;
  authoritative: boolean;
  truncated: boolean;
  answer: WireRecord[];
  authority: WireRecord[];
  additional: WireRecord[];
};

function encodeName(name: string): Buffer {
  const parts: Buffer[] = [];
  for (const label of name.replace(/\.$/, "").split(".")) {
    if (!label) continue;
    const b = Buffer.from(label, "ascii");
    if (b.length > 63) throw new Error(`${name} has a label longer than 63`);
    parts.push(Buffer.from([b.length]), b);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/** A query for one name and type; recursion is not asked for. */
export function encodeQuery(id: number, name: string, type: QType): Buffer {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(id, 0);
  head.writeUInt16BE(0, 2);
  head.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(QTYPE[type], 0);
  tail.writeUInt16BE(1, 2);
  return Buffer.concat([head, encodeName(name), tail]);
}

function readName(buf: Buffer, start: number): [string, number] {
  const labels: string[] = [];
  let at = start;
  let end = -1;
  for (let hops = 0; hops < 64; hops++) {
    if (at >= buf.length) throw new Error("a name runs past the message");
    const len = buf[at];
    if (len === 0) {
      return [labels.join(".").toLowerCase(), end < 0 ? at + 1 : end];
    }
    if ((len & 0xc0) === 0xc0) {
      if (at + 1 >= buf.length)
        throw new Error("a pointer runs past the message");
      if (end < 0) end = at + 2;
      at = ((len & 0x3f) << 8) | buf[at + 1];
      continue;
    }
    if (at + 1 + len > buf.length)
      throw new Error("a label runs past the message");
    labels.push(buf.toString("ascii", at + 1, at + 1 + len));
    at += 1 + len;
  }
  throw new Error("a name points at itself");
}

function readRecord(buf: Buffer, start: number): [WireRecord, number] {
  const [name, at] = readName(buf, start);
  if (at + 10 > buf.length) throw new Error("a record runs past the message");
  const type = buf.readUInt16BE(at);
  const ttl = buf.readUInt32BE(at + 4);
  const len = buf.readUInt16BE(at + 8);
  const rd = at + 10;
  if (rd + len > buf.length) throw new Error("a record runs past the message");
  let data = "";
  if (type === QTYPE.A && len === 4)
    data = [...buf.subarray(rd, rd + 4)].join(".");
  else if (type === QTYPE.AAAA && len === 16) {
    const words: string[] = [];
    for (let i = 0; i < 16; i += 2)
      words.push(buf.readUInt16BE(rd + i).toString(16));
    data = compressV6(words);
  } else if (type === QTYPE.NS || type === QTYPE.CNAME)
    data = readName(buf, rd)[0];
  else if (type === QTYPE.SOA) data = readName(buf, rd)[0];
  return [{ name, type, ttl, data }, rd + len];
}

/** The shortest form of an IPv6 address, as `net` and the agents write it. */
function compressV6(words: string[]): string {
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (words[i] !== "0") {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && words[j] === "0") j++;
    if (j - i > bestLen && j - i > 1) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  if (best < 0) return words.join(":");
  return `${words.slice(0, best).join(":")}::${words.slice(best + bestLen).join(":")}`;
}

/** Reads an answer; throws on a message that does not hold together. */
export function decodeAnswer(buf: Buffer): WireAnswer {
  if (buf.length < 12) throw new Error("a DNS answer shorter than its header");
  const flags = buf.readUInt16BE(2);
  const counts = [4, 6, 8, 10].map((o) => buf.readUInt16BE(o));
  let at = 12;
  for (let i = 0; i < counts[0]; i++) at = readName(buf, at)[1] + 4;
  const sections: WireRecord[][] = [[], [], []];
  for (let s = 0; s < 3; s++)
    for (let i = 0; i < counts[s + 1]; i++) {
      const [rec, next] = readRecord(buf, at);
      sections[s].push(rec);
      at = next;
    }
  return {
    id: buf.readUInt16BE(0),
    rcode: flags & 0x0f,
    authoritative: (flags & 0x0400) !== 0,
    truncated: (flags & 0x0200) !== 0,
    answer: sections[0],
    authority: sections[1],
    additional: sections[2],
  };
}

/** An answer, for the tests' fake name servers: the question echoed, then each section's records. */
export function encodeAnswer(
  id: number,
  question: { name: string; type: QType },
  opts: {
    rcode?: number;
    authoritative?: boolean;
    answer?: { name: string; type: QType; data: string }[];
    authority?: { name: string; type: QType; data: string }[];
    additional?: { name: string; type: QType; data: string }[];
  },
): Buffer {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(id, 0);
  head.writeUInt16BE(
    0x8000 | (opts.authoritative ? 0x0400 : 0) | (opts.rcode ?? 0),
    2,
  );
  const sections = [
    opts.answer ?? [],
    opts.authority ?? [],
    opts.additional ?? [],
  ];
  head.writeUInt16BE(1, 4);
  sections.forEach((s, i) => head.writeUInt16BE(s.length, 6 + i * 2));
  const q = Buffer.concat([
    encodeName(question.name),
    Buffer.from([0, QTYPE[question.type], 0, 1]),
  ]);
  const records = sections.flat().map((r) => {
    let data: Buffer;
    if (r.type === "A") data = Buffer.from(r.data.split(".").map(Number));
    else if (r.type === "AAAA") data = v6Bytes(r.data);
    else data = encodeName(r.data);
    const fixed = Buffer.alloc(10);
    fixed.writeUInt16BE(QTYPE[r.type], 0);
    fixed.writeUInt16BE(1, 2);
    fixed.writeUInt32BE(300, 4);
    fixed.writeUInt16BE(data.length, 8);
    return Buffer.concat([encodeName(r.name), fixed, data]);
  });
  return Buffer.concat([head, q, ...records]);
}

function v6Bytes(addr: string): Buffer {
  const [left, right = ""] = addr.split("::");
  const l = left ? left.split(":") : [];
  const r = right ? right.split(":") : [];
  const words = addr.includes("::")
    ? [...l, ...Array(8 - l.length - r.length).fill("0"), ...r]
    : l;
  const out = Buffer.alloc(16);
  words.forEach((w, i) => out.writeUInt16BE(parseInt(w, 16), i * 2));
  return out;
}
