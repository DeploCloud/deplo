import { gzipSync } from "node:zlib";

function header(name: string, size: number, mode: number, type = "0"): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, "utf8");
  h.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8, "latin1");
  h.write("0000000\0", 108, 8, "latin1");
  h.write("0000000\0", 116, 8, "latin1");
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "latin1");
  h.write("00000000000\0", 136, 12, "latin1");
  h.write("        ", 148, 8, "latin1");
  h.write(type, 156, 1, "latin1");
  h.write("ustar\0", 257, 6, "latin1");
  h.write("00", 263, 2, "latin1");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  return h;
}

export interface TarFile {
  name: string;
  content: string | Buffer;
  mode?: number;
  type?: string;
}

// A gzipped tar shaped like a GitHub or GitLab archive: everything under one top folder.
export function tarGz(
  files: TarFile[],
  top = "repo-abc123",
): Uint8Array<ArrayBuffer> {
  const parts: Buffer[] = [header(`${top}/`, 0, 0o755, "5")];
  for (const f of files) {
    const body = Buffer.isBuffer(f.content)
      ? f.content
      : Buffer.from(f.content);
    parts.push(
      header(`${top}/${f.name}`, body.length, f.mode ?? 0o644, f.type),
    );
    parts.push(body, Buffer.alloc((512 - (body.length % 512)) % 512, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  return new Uint8Array(gzipSync(Buffer.concat(parts)));
}

export async function* chunksOf(
  buf: Uint8Array,
  size = 4096,
): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

export interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
}

type Route = (call: RecordedCall) => Response | Promise<Response> | null;

// A fetch that answers from routes and records every request, so a test can read what was sent.
export function fakeFetch(routes: Route[]) {
  const calls: RecordedCall[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    let body: unknown = init?.body ?? null;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep the text */
      }
    }
    const call = { method: (init?.method ?? "GET").toUpperCase(), url, body };
    calls.push(call);
    for (const route of routes) {
      const res = await route(call);
      if (res) return res;
    }
    return new Response("not found", { status: 404 });
  };
  return { fn: fn as typeof fetch, calls };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
