import { gzipSync } from "node:zlib";

function tarEntry(name: string, body: Buffer, type = "0"): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "latin1");
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  header.write(type, 156, "latin1");
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, pad]);
}

export function tarGz(files: [string, Buffer][]): Buffer {
  return gzipSync(
    Buffer.concat([
      tarEntry("./", Buffer.alloc(0), "5"),
      ...files.map(([name, body]) => tarEntry(name, body)),
      Buffer.alloc(1024),
    ]),
  );
}

export const EMPTY_TAR_GZ = tarGz([]);

export function tarGzOf(size: number, fill: number): Buffer {
  return tarGz([["./blob", Buffer.alloc(size, fill)]]);
}
