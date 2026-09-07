import "server-only";

/** The most a request body may be on the routes below. */
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * A `Request` whose body cannot exceed `max` bytes: refused up front when the
 * caller declares more, and cut off mid-stream when it does not declare at all.
 * Node buffers whatever a handler reads, and every route here reads before it
 * knows who is calling.
 */
export function capRequestBody(
  request: Request,
  max = MAX_BODY_BYTES,
): Request | Response {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return tooLarge(max);
  if (!request.body) return request;
  let seen = 0;
  const capped = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) controller.error(new BodyTooLargeError(max));
        else controller.enqueue(chunk);
      },
    }),
  );
  return new Request(request, { body: capped, duplex: "half" } as RequestInit);
}

/** `request.text()` under the cap: a 413 `Response` instead of a string when over. */
export async function readTextCapped(
  request: Request,
  max = MAX_BODY_BYTES,
): Promise<string | Response> {
  const capped = capRequestBody(request, max);
  if (capped instanceof Response) return capped;
  try {
    return await capped.text();
  } catch (e) {
    if (e instanceof BodyTooLargeError) return tooLarge(max);
    throw e;
  }
}

export class BodyTooLargeError extends Error {
  constructor(max: number) {
    super(`request body exceeds ${max} bytes`);
    this.name = "BodyTooLargeError";
  }
}

function tooLarge(max: number): Response {
  return Response.json(
    { error: `Request body too large (${Math.round(max / 1024)} KiB max)` },
    { status: 413 },
  );
}
