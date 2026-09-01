import { constantTimeEquals } from "@/lib/crypto";
import {
  markTakeoverProgress,
  takeoverStatus,
  type TakeoverState,
} from "@/lib/data/takeover";

/**
 * The installer's end of a takeover. It runs on the host, holds
 * `DEPLO_HOST_BOOTSTRAP_TOKEN`, and cannot present a session cookie - so this is
 * a REST exception authenticated the way `agent/bootstrap` is.
 *
 * GET is the poll: how far the operator has got, and whether anything but the
 * installer has ever reached this panel (which is how a closed port is caught
 * instead of announced as a success).
 */

function authorized(request: Request): boolean {
  const expected = process.env.DEPLO_HOST_BOOTSTRAP_TOKEN?.trim();
  if (!expected) return false;
  const header = request.headers.get("authorization") ?? "";
  const presented = header.replace(/^Bearer\s+/i, "").trim();
  return Boolean(presented) && constantTimeEquals(presented, expected);
}

export async function GET(request: Request) {
  if (!authorized(request))
    return Response.json({ error: "unauthorized" }, { status: 401 });
  const status = await takeoverStatus();
  return Response.json(status ?? { state: null }, {
    headers: { "cache-control": "no-store" },
  });
}

/** The installer reporting what it finished: the ports, or the removal. */
export async function POST(request: Request) {
  if (!authorized(request))
    return Response.json({ error: "unauthorized" }, { status: 401 });

  let body: { state?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const state = body.state;
  if (state !== "done" && state !== "removed")
    return Response.json(
      { error: 'state must be "done" or "removed"' },
      { status: 400 },
    );

  try {
    const next: Extract<TakeoverState, "done" | "removed"> = state;
    return Response.json(await markTakeoverProgress(next));
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "refused" },
      { status: 409 },
    );
  }
}
