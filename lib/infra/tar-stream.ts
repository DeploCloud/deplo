/**
 * A minimal, streaming TAR reader - enough to pull ONE named entry out of an
 * archive that arrives as a sequence of chunks, without ever holding the whole
 * archive (or any entry we don't want) in memory.
 */

const BLOCK_SIZE = 512;
/** A meta entry (PAX/GNU long name) never legitimately exceeds this. */
const MAX_META_BYTES = 64 * 1024;

/** One regular-file entry surfaced by {@link tarEntries}. */
export interface TarEntry {
  /** POSIX path as written by the producer (prefix/long-name already applied). */
  name: string;
  /** Byte length declared by the header. */
  size: number;
  /**
   * The entry's bytes, or null when the caller's `read` predicate declined it -
   * declined entries are streamed past, never buffered.
   */
  bytes: Buffer | null;
}

export interface TarEntriesOptions {
  /**
   * Decide whether an entry's bytes are worth buffering. Called once per regular
   * file, BEFORE any of its data is read. Default: buffer nothing (metadata-only
   * scan).
   */
  read?: (entry: { name: string; size: number }) => boolean;
  /**
   * Give up (end the iteration) once this many raw archive bytes have been
   * consumed. The guard that keeps a scan of an unexpectedly huge directory
   * bounded. Default: unbounded.
   */
  maxScanBytes?: number;
}

/**
 * A FIFO of byte chunks that hands out exact-length slices without re-copying
 * the backlog on every push (the naive `Buffer.concat` per chunk is quadratic
 * over a large archive).
 */
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

  /** Remove and return exactly `n` bytes, or null when fewer are queued. */
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

  /** Drop up to `n` bytes; returns how many were actually dropped. */
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

/** Read a NUL-terminated ASCII field. */
function readString(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("latin1");
}

/**
 * Read a numeric header field. Returns -1 for a field we can't trust - the caller
 * treats that as a corrupt archive rather than guessing a length.
 */
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

/** Whether every byte of a block is zero (the archive's end marker). */
function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false;
  return true;
}

/**
 * Validate a header block's checksum: the sum of its bytes with the checksum field
 * itself read as spaces.
 */
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
    // The `prefix` field only means anything under ustar/GNU magic.
    prefix: magic.startsWith("ustar") ? readString(block, 345, 155) : "",
    size,
    type: String.fromCharCode(block[156] || 0x30),
  };
}

/**
 * The `path=` override out of a PAX record blob, or null when absent.
 */
function paxPath(data: Buffer): string | null {
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset); // " "
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

/**
 * Where the parser is: between entries (expecting a 512-byte header block), or
 * inside one's payload. `collected` is null for an entry whose bytes the caller
 * declined - its data is streamed past, never buffered.
 */
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

/** A regular file - `0`, the legacy NUL, and GNU's contiguous `7`. */
function isRegularFile(type: string): boolean {
  return type === "0" || type === "\0" || type === "7";
}

/**
 * Iterate the regular-file entries of a tar stream, buffering only the entries the
 * `read` predicate accepts.
 */
export async function* tarEntries(
  chunks: AsyncIterable<Uint8Array>,
  opts: TarEntriesOptions = {},
): AsyncGenerator<TarEntry, void, unknown> {
  const queue = new ByteQueue();
  const maxScanBytes = opts.maxScanBytes ?? Number.POSITIVE_INFINITY;
  const wantBytes = opts.read ?? (() => false);

  let scanned = 0;
  let zeroBlocks = 0;
  /** Name carried by a preceding GNU `L` / PAX `path=` record, if any. */
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
          // Two consecutive zero blocks close the archive; a single one inside a
          // padded stream is tolerated.
          if (++zeroBlocks >= 2) return;
          continue;
        }
        zeroBlocks = 0;
        const header = parseHeader(block);
        if (!header) return; // corrupt / desynchronised - stop, never guess
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
        if (available === 0) break; // wait for the next chunk
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
      // A global PAX header (`g`) applies to the whole archive and carries no
      // per-entry name; anything else (dir, link, device) is skipped outright.
      overrideName = null;
      if (entry.type === "g" || !isRegularFile(entry.type)) continue;
      yield { name: entry.name, size: entry.size, bytes: entry.bytes };
    }

    if (scanned >= maxScanBytes) return;
  }
}

/** Strip a single leading `./` so `./a/b` and `a/b` compare equal. */
function normalizeEntryName(name: string): string {
  return name.replace(/^\.\/+/, "");
}

export interface ReadTarEntryOptions {
  /** Archive-relative path to extract (a leading `./` is ignored on both sides). */
  name: string;
  /** Refuse (and skip) a matching entry larger than this. */
  maxEntryBytes: number;
  /** Stop scanning after this many raw archive bytes. */
  maxScanBytes: number;
}

/**
 * Pull ONE named entry's bytes out of a tar stream, or null when it isn't there
 * (or is bigger than `maxEntryBytes`, or the scan budget ran out first).
 */
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
