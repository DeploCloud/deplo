const BLOCK_SIZE = 512;
const MAX_META_BYTES = 64 * 1024;

export interface TarEntry {
  name: string;
  size: number;
  bytes: Buffer | null;
}

export interface TarEntriesOptions {
  read?: (entry: { name: string; size: number }) => boolean;
  maxScanBytes?: number;
}

class ByteQueue {
  private chunks: Buffer[] = [];
  private queued = 0;

  get length(): number {
    return this.queued;
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.queued += chunk.length;
  }

  take(n: number): Buffer | null {
    if (n > this.queued) return null;
    if (n === 0) return Buffer.alloc(0);
    const out = Buffer.allocUnsafe(n);
    let written = 0;
    while (written < n) {
      const head = this.chunks[0];
      const need = n - written;
      if (head.length <= need) {
        head.copy(out, written);
        written += head.length;
        this.chunks.shift();
      } else {
        head.copy(out, written, 0, need);
        this.chunks[0] = head.subarray(need);
        written = n;
      }
    }
    this.queued -= n;
    return out;
  }

  drop(n: number): number {
    let dropped = 0;
    while (dropped < n && this.chunks.length > 0) {
      const head = this.chunks[0];
      const need = n - dropped;
      if (head.length <= need) {
        dropped += head.length;
        this.chunks.shift();
      } else {
        this.chunks[0] = head.subarray(need);
        dropped = n;
      }
    }
    this.queued -= dropped;
    return dropped;
  }
}

interface RawHeader {
  name: string;
  prefix: string;
  size: number;
  type: string;
}

function readString(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("latin1");
}

function readNumber(block: Buffer, start: number, length: number): number {
  const raw = block.subarray(start, start + length);
  if (raw.length > 0 && (raw[0] & 0x80) !== 0) {
    let value = 0;
    for (let i = 1; i < raw.length; i++) {
      value = value * 256 + raw[i];
      if (!Number.isSafeInteger(value)) return -1;
    }
    return value;
  }
  const text = readString(block, start, length).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) return -1;
  const value = parseInt(text, 8);
  return Number.isSafeInteger(value) ? value : -1;
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false;
  return true;
}

function checksumOk(block: Buffer): boolean {
  const stored = readNumber(block, 148, 8);
  if (stored < 0) return false;
  let signed = 0;
  let unsigned = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    const byte = i >= 148 && i < 156 ? 0x20 : block[i];
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return stored === unsigned || stored === signed;
}

function parseHeader(block: Buffer): RawHeader | null {
  if (!checksumOk(block)) return null;
  const size = readNumber(block, 124, 12);
  if (size < 0) return null;
  const magic = readString(block, 257, 6);
  return {
    name: readString(block, 0, 100),
    prefix: magic.startsWith("ustar") ? readString(block, 345, 155) : "",
    size,
    type: String.fromCharCode(block[156] || 0x30),
  };
}

function paxPath(data: Buffer): string | null {
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number(data.subarray(offset, space).toString("latin1"));
    if (!Number.isSafeInteger(length) || length <= 0) break;
    const end = offset + length;
    if (end > data.length || space + 1 >= end) break;
    const record = data
      .subarray(space + 1, end)
      .toString("utf8")
      .replace(/\n$/, "");
    const eq = record.indexOf("=");
    if (eq > 0 && record.slice(0, eq) === "path") return record.slice(eq + 1);
    offset = end;
  }
  return null;
}

type ParserState =
  | { kind: "header" }
  | {
      kind: "data";
      name: string;
      size: number;
      type: string;
      remaining: number;
      padding: number;
      collected: Buffer[] | null;
    };

function isRegularFile(type: string): boolean {
  return type === "0" || type === "\0" || type === "7";
}

export async function* tarEntries(
  chunks: AsyncIterable<Uint8Array>,
  opts: TarEntriesOptions = {},
): AsyncGenerator<TarEntry, void, unknown> {
  const queue = new ByteQueue();
  const maxScanBytes = opts.maxScanBytes ?? Number.POSITIVE_INFINITY;
  const wantBytes = opts.read ?? (() => false);

  let scanned = 0;
  let zeroBlocks = 0;
  let overrideName: string | null = null;
  let state: ParserState = { kind: "header" };

  for await (const chunk of chunks) {
    scanned += chunk.length;
    queue.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));

    for (;;) {
      if (state.kind === "header") {
        const block = queue.take(BLOCK_SIZE);
        if (!block) break;
        if (isZeroBlock(block)) {
          if (++zeroBlocks >= 2) return;
          continue;
        }
        zeroBlocks = 0;
        const header = parseHeader(block);
        if (!header) return;
        const name: string =
          overrideName ??
          (header.prefix ? `${header.prefix}/${header.name}` : header.name);
        const meta =
          header.type === "x" || header.type === "X" || header.type === "L";
        state = {
          kind: "data",
          name,
          size: header.size,
          type: header.type,
          remaining: header.size,
          padding: (BLOCK_SIZE - (header.size % BLOCK_SIZE)) % BLOCK_SIZE,
          collected: meta
            ? header.size <= MAX_META_BYTES
              ? []
              : null
            : isRegularFile(header.type) &&
                wantBytes({ name, size: header.size })
              ? []
              : null,
        };
        continue;
      }

      if (state.remaining > 0) {
        const available = Math.min(state.remaining, queue.length);
        if (available === 0) break;
        const part = queue.take(available)!;
        state.collected?.push(part);
        state.remaining -= available;
        if (state.remaining > 0) break;
      }
      if (state.padding > 0) {
        state.padding -= queue.drop(state.padding);
        if (state.padding > 0) break;
      }

      const entry: {
        name: string;
        size: number;
        type: string;
        bytes: Buffer | null;
      } = {
        name: state.name,
        size: state.size,
        type: state.type,
        bytes: state.collected ? Buffer.concat(state.collected) : null,
      };
      state = { kind: "header" };

      if (entry.type === "L") {
        overrideName = entry.bytes
          ? entry.bytes.toString("utf8").replace(/\0+$/, "")
          : null;
        continue;
      }
      if (entry.type === "x" || entry.type === "X") {
        overrideName = entry.bytes ? paxPath(entry.bytes) : null;
        continue;
      }
      overrideName = null;
      if (entry.type === "g" || !isRegularFile(entry.type)) continue;
      yield { name: entry.name, size: entry.size, bytes: entry.bytes };
    }

    if (scanned >= maxScanBytes) return;
  }
}

function normalizeEntryName(name: string): string {
  return name.replace(/^\.\/+/, "");
}

export interface ReadTarEntryOptions {
  name: string;
  maxEntryBytes: number;
  maxScanBytes: number;
}

export async function readTarEntry(
  chunks: AsyncIterable<Uint8Array>,
  opts: ReadTarEntryOptions,
): Promise<Buffer | null> {
  const wanted = normalizeEntryName(opts.name);
  for await (const entry of tarEntries(chunks, {
    maxScanBytes: opts.maxScanBytes,
    read: (e) =>
      normalizeEntryName(e.name) === wanted && e.size <= opts.maxEntryBytes,
  })) {
    if (entry.bytes && normalizeEntryName(entry.name) === wanted)
      return entry.bytes;
  }
  return null;
}
