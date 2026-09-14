import "server-only";

// MAX_BODY_BYTES is the most a request body may be on the routes below.
export const MAX_BODY_BYTES = 1024 * 1024;

// readTextCapped reads the body under a byte cap - by hand, because Next gives a route handler its own Request subclass that throws on `.json()` for a rebuilt piped body.
export async function readTextCapped(
  request: Request,
  max = MAX_BODY_BYTES,
): Promise<string | Response> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return tooLarge(max);
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.byteLength;
    if (seen > max) {
      await reader.cancel();
      return tooLarge(max);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// capRequestBody returns the same request with its body already read and bounded, for a handler that needs a Request.
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
