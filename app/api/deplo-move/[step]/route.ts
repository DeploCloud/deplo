import {
  MOVE_FILENAME_HEADER,
  MOVE_PEER_HEADER,
  MOVE_PEER_URL_HEADER,
  isMoveStep,
  type MoveStep,
  type WorkloadRef,
} from "@/lib/deplo-move/protocol";
import {
  MoveRefusedError,
  dataRefusal,
  moveCancel,
  moveDump,
  moveFiles,
  moveFinish,
  moveHello,
  moveHostPath,
  moveImage,
  movePause,
  moveResume,
  moveUpload,
  moveVolume,
  moveWorkload,
  type MoveCaller,
  type MoveDataStream,
} from "@/lib/data/deplo-move/source-api";
import { userFacingMessage } from "@/lib/graphql/mask-error";
import { readTextCapped } from "@/lib/http/body-cap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function refused(message: string, status: number, agentCode?: number) {
  return Response.json(
    agentCode === undefined
      ? { error: message }
      : { error: message, code: agentCode },
    { status },
  );
}

function failed(e: unknown): Response {
  if (e instanceof MoveRefusedError)
    return refused(e.message, e.status, e.agentCode);
  const message = userFacingMessage(e);
  if (message == null) console.error("[deplo-move] a step failed:", e);
  // Never 502-504: the new Deplo reads those as this panel being down.
  return refused(message ?? "Something went wrong on the old Deplo.", 500);
}

function streamOf<T>(
  first: T,
  rest: AsyncIterator<T>,
  encode: (v: T) => Uint8Array,
  close: () => void = () => {},
): ReadableStream<Uint8Array> {
  let sentFirst = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentFirst) {
        sentFirst = true;
        controller.enqueue(encode(first));
        return;
      }
      try {
        const next = await rest.next();
        if (next.done) {
          close();
          controller.close();
        } else controller.enqueue(encode(next.value));
      } catch (e) {
        // A cut stream is a failure on the new Deplo: a dump ends with an `end` frame, an archive with its trailer.
        console.error("[deplo-move] the copy stopped mid-stream:", e);
        close();
        controller.error(e);
      }
    },
    async cancel() {
      await rest.return?.();
      close();
    },
  });
}

async function dumpResponse(caller: MoveCaller): Promise<Response> {
  const it = (await moveDump(caller))[Symbol.asyncIterator]();
  const first = await it.next();
  if (first.done) return refused("The old Deplo sent nothing to copy.", 500);
  const enc = new TextEncoder();
  const line = (s: string) => enc.encode(s.endsWith("\n") ? s : `${s}\n`);
  return new Response(streamOf(first.value, it, line), {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
    },
  });
}

// Raw bytes. The first chunk is read before answering, so an agent's refusal is still a JSON error.
async function dataResponse(open: Promise<MoveDataStream>): Promise<Response> {
  const data = await open;
  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    "Cache-Control": "no-store",
  };
  if (data.filename !== undefined)
    headers[MOVE_FILENAME_HEADER] = encodeURIComponent(data.filename);
  const it = data.chunks[Symbol.asyncIterator]();
  let first: IteratorResult<Buffer>;
  try {
    first = await it.next();
  } catch (e) {
    data.close();
    return failed(dataRefusal(e));
  }
  if (first.done) {
    data.close();
    return new Response(null, { status: 204, headers });
  }
  return new Response(
    streamOf(first.value, it, (b) => new Uint8Array(b), data.close),
    { headers },
  );
}

async function run(
  step: MoveStep,
  caller: MoveCaller,
  body: Record<string, unknown>,
): Promise<Response> {
  const field = (k: string) => String(body[k] ?? "");
  const ref = { kind: body.kind, id: field("id") } as Partial<WorkloadRef>;
  switch (step) {
    case "hello":
      return Response.json(await moveHello(caller));
    case "dump":
      return dumpResponse(caller);
    case "workload":
      return Response.json(await moveWorkload(caller, ref));
    case "pause":
      return Response.json(await movePause(caller, ref));
    case "resume":
      return Response.json(await moveResume(caller, ref));
    case "volume":
      return dataResponse(
        moveVolume(caller, { ...ref, volume: field("volume") }),
      );
    case "hostpath":
      return dataResponse(
        moveHostPath(caller, {
          ...ref,
          path: field("path"),
          allowFile: body.allowFile === true,
        }),
      );
    case "files":
      return dataResponse(moveFiles(caller, ref));
    case "image":
      return dataResponse(
        moveImage(caller, { ...ref, imageRef: field("imageRef") }),
      );
    case "upload":
      return dataResponse(moveUpload(caller, ref));
    case "finish":
      return Response.json(await moveFinish(caller));
    case "cancel":
      return Response.json(await moveCancel(caller));
  }
}

// The old Deplo's side of a Deplo move (ADR-0035). The move code is the only credential; the data layer checks it.
export async function POST(
  request: Request,
  ctx: { params: Promise<{ step: string }> },
) {
  const { step } = await ctx.params;
  if (!isMoveStep(step)) return refused("Unknown step.", 404);
  const header = request.headers.get("authorization") ?? "";
  const caller: MoveCaller = {
    code: /^bearer /i.test(header) ? header.slice(7).trim() : "",
    peerInstance: request.headers.get(MOVE_PEER_HEADER) ?? "",
    peerUrl: request.headers.get(MOVE_PEER_URL_HEADER) ?? "",
  };

  const text = await readTextCapped(request);
  if (text instanceof Response) return text;
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = text.trim() ? JSON.parse(text) : {};
    if (typeof parsed === "object" && parsed !== null)
      body = parsed as Record<string, unknown>;
  } catch {
    return refused("The body must be JSON.", 400);
  }

  try {
    return await run(step, caller, body);
  } catch (e) {
    return failed(e);
  }
}
