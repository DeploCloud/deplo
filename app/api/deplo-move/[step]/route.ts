import {
  MOVE_PEER_HEADER,
  MOVE_PEER_URL_HEADER,
  isMoveStep,
  type MoveStep,
} from "@/lib/deplo-move/protocol";
import {
  MoveRefusedError,
  moveCsr,
  moveDump,
  moveFinish,
  moveFreeze,
  moveHello,
  moveInstall,
  moveThaw,
  type MoveCaller,
} from "@/lib/data/deplo-move/source-api";
import { userFacingMessage } from "@/lib/graphql/mask-error";
import { readTextCapped } from "@/lib/http/body-cap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function refused(message: string, status: number, handedOver = false) {
  return Response.json(
    handedOver ? { error: message, handedOver } : { error: message },
    { status },
  );
}

function ndjson(
  first: string,
  rest: AsyncIterator<string>,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const line = (s: string) => enc.encode(s.endsWith("\n") ? s : `${s}\n`);
  let sentFirst = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentFirst) {
        sentFirst = true;
        controller.enqueue(line(first));
        return;
      }
      try {
        const next = await rest.next();
        if (next.done) controller.close();
        else controller.enqueue(line(next.value));
      } catch (e) {
        // The dump ends with an `end` frame, so the new Deplo reads a cut stream as a failure.
        console.error("[deplo-move] the copy stopped mid-stream:", e);
        controller.error(e);
      }
    },
    async cancel() {
      await rest.return?.();
    },
  });
}

async function dumpResponse(caller: MoveCaller): Promise<Response> {
  const it = (await moveDump(caller))[Symbol.asyncIterator]();
  const first = await it.next();
  if (first.done) return refused("The old Deplo sent nothing to copy.", 500);
  return new Response(ndjson(first.value, it), {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
    },
  });
}

async function run(
  step: MoveStep,
  caller: MoveCaller,
  body: Record<string, unknown>,
): Promise<Response> {
  const field = (k: string) => String(body[k] ?? "");
  switch (step) {
    case "hello":
      return Response.json(await moveHello(caller));
    case "freeze":
      return Response.json(await moveFreeze(caller));
    case "dump":
      return dumpResponse(caller);
    case "csr":
      return Response.json(await moveCsr(caller, field("serverId")));
    case "install":
      return Response.json(
        await moveInstall(caller, {
          serverId: field("serverId"),
          certPem: field("certPem"),
          caPem: field("caPem"),
        }),
      );
    case "finish":
      return Response.json(
        await moveFinish(caller, {
          movedTo: field("movedTo"),
          handedOver: Array.isArray(body.handedOver)
            ? body.handedOver.map(String)
            : [],
        }),
      );
    case "thaw":
      return Response.json(await moveThaw(caller));
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
    if (e instanceof MoveRefusedError)
      return refused(e.message, e.status, e.handedOver);
    const message = userFacingMessage(e);
    if (message == null) console.error("[deplo-move] a step failed:", e);
    return refused(message ?? "Something went wrong on the old Deplo.", 500);
  }
}
