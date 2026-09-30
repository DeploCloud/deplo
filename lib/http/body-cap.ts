import "server-only";

export const MAX_BODY_BYTES = 1024 * 1024;

// null = over the cap. Works on a fetch Response as well as a Request.
export async function readBytesCapped(
  source: Pick<Request, "headers" | "body">,
  max: number,
): Promise<Buffer | null> {
  const declared = Number(source.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!source.body) return Buffer.alloc(0);
  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.byteLength;
    if (seen > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function readTextCapped(
  request: Request,
  max = MAX_BODY_BYTES,
): Promise<string | Response> {
  const bytes = await readBytesCapped(request, max);
  return bytes ? bytes.toString("utf8") : tooLarge(max);
}

export async function capRequestBody(
  request: Request,
  max = MAX_BODY_BYTES,
): Promise<Request | Response> {
  if (!request.body) return request;
  const raw = await readTextCapped(request, max);
  if (raw instanceof Response) return raw;
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: raw,
  });
}

function tooLarge(max: number): Response {
  return Response.json(
    { error: `Request body too large (${Math.round(max / 1024)} KiB max)` },
    { status: 413 },
  );
}
