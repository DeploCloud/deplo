/**
 * Hand-rolled TAR builders for tests. Named `*-test-helpers.ts` so the test
 * runner's `*.test.ts` glob doesn't try to execute it.
 *
 * Building archives byte by byte (rather than shelling out to `tar`) is the
 * point: the parser in {@link file://./tar-stream.ts} is then pinned against the
 * FORMAT — ustar prefixes, PAX records, padding — and not against whichever tar
 * the machine happens to ship.
 */

const BLOCK = 512;

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

/** One 512-byte header block with a correct checksum. */
export function tarHeader(opts: {
  name: string;
  size: number;
  type?: string;
  prefix?: string;
  ustar?: boolean;
}): Buffer {
  const block = Buffer.alloc(BLOCK, 0);
  block.write(opts.name, 0, 100, "latin1");
  block.write(octal(0o644, 8), 100, 8, "latin1");
  block.write(octal(0, 8), 108, 8, "latin1");
  block.write(octal(0, 8), 116, 8, "latin1");
  block.write(octal(opts.size, 12), 124, 12, "latin1");
  block.write(octal(0, 12), 136, 12, "latin1");
  block.write("        ", 148, 8, "latin1"); // checksum placeholder = spaces
  block.write(opts.type ?? "0", 156, 1, "latin1");
  if (opts.ustar !== false) {
    block.write("ustar\0", 257, 6, "latin1");
    block.write("00", 263, 2, "latin1");
  }
  if (opts.prefix) block.write(opts.prefix, 345, 155, "latin1");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(octal(sum, 8), 148, 8, "latin1");
  return block;
}

/** A header + its body, padded to whole 512-byte blocks. */
export function tarEntry(
  name: string,
  data: Buffer | string,
  opts: { type?: string; prefix?: string } = {},
): Buffer {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const pad = (BLOCK - (buf.length % BLOCK)) % BLOCK;
  return Buffer.concat([
    tarHeader({ name, size: buf.length, type: opts.type, prefix: opts.prefix }),
    buf,
    Buffer.alloc(pad, 0),
  ]);
}

/** The two zero blocks that close an archive. */
export const TAR_END = Buffer.alloc(BLOCK * 2, 0);

/** A complete archive from `[name, data]` pairs. */
export function buildTar(files: [string, Buffer | string][]): Buffer {
  return Buffer.concat([...files.map(([name, data]) => tarEntry(name, data)), TAR_END]);
}

/** Feed a buffer as an async stream, optionally sliced into small chunks. */
export async function* tarStream(
  buf: Buffer,
  chunkSize = buf.length,
): AsyncGenerator<Buffer> {
  for (let off = 0; off < buf.length; off += chunkSize) {
    yield buf.subarray(off, Math.min(off + chunkSize, buf.length));
  }
}

/**
 * A PAX extended-header record, `"<len> <key>=<value>\n"`, where `<len>` counts
 * its own bytes — the same fixpoint Go's `archive/tar` computes when it writes
 * one (which it does for any path over 100 bytes).
 */
export function paxRecord(key: string, value: string): Buffer {
  const kv = `${key}=${value}\n`;
  let size = Buffer.byteLength(kv) + 2;
  for (let i = 0; i < 8; i++) {
    const actual = Buffer.byteLength(`${size} ${kv}`);
    if (actual === size) return Buffer.from(`${size} ${kv}`);
    size = actual;
  }
  throw new Error("pax record length did not converge");
}
