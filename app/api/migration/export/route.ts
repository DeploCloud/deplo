import { runWithIdentity } from "@/lib/auth/request-context";
import { TEAM_HEADER } from "@/lib/team-path";
import {
  ExportRefusedError,
  checkWorkloadData,
  openWorkloadData,
  type WorkloadRef,
} from "@/lib/data/migration-export/data-stream";
import { authenticateToken } from "@/lib/data/tokens/authenticate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ExportRequest extends WorkloadRef {
  volume?: string;
  hostPath?: string;
  allowFile?: boolean;
  check?: string[];
}

function refused(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function streamOf(
  first: Buffer,
  rest: AsyncIterator<Buffer>,
  close: () => void,
): ReadableStream<Uint8Array> {
  let sentFirst = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentFirst) {
        sentFirst = true;
        controller.enqueue(new Uint8Array(first));
        return;
      }
      try {
        const next = await rest.next();
        if (next.done) {
          close();
          controller.close();
        } else controller.enqueue(new Uint8Array(next.value));
      } catch (e) {
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

// Another Deplo reading one of this team's volumes for a migration (ADR-0034). The data layer owns every gate.
export async function POST(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const raw = /^bearer /i.test(header) ? header.slice(7).trim() : "";
  const principal = raw
    ? await authenticateToken(raw, request.headers.get(TEAM_HEADER)).catch(
        () => null,
      )
    : null;
  if (!principal)
    return refused(
      "Missing or invalid API token. Send an `Authorization: Bearer deplo_…` header.",
      401,
    );

  let body: ExportRequest;
  try {
    body = (await request.json()) as ExportRequest;
  } catch {
    return refused("The body must be JSON.", 400);
  }
  const ref: WorkloadRef = { kind: body.kind, id: String(body.id ?? "") };

  return runWithIdentity(principal, async () => {
    try {
      if (Array.isArray(body.check))
        return Response.json(
          await checkWorkloadData(ref, body.check.map(String)),
        );

      const { chunks, close } = await openWorkloadData(ref, {
        volume: body.volume,
        hostPath: body.hostPath,
        allowFile: body.allowFile,
      });
      const it = chunks[Symbol.asyncIterator]();
      let first: IteratorResult<Buffer>;
      try {
        first = await it.next();
      } catch (e) {
        close();
        const code = (e as { code?: unknown } | null)?.code;
        const message = e instanceof Error ? e.message : String(e);
        return refused(message, code === 5 ? 404 : 502);
      }
      if (first.done) {
        close();
        return new Response(null, { status: 204 });
      }
      return new Response(streamOf(first.value, it, close), {
        headers: {
          "Content-Type": "application/gzip",
          "Cache-Control": "no-store",
        },
      });
    } catch (e) {
      if (e instanceof ExportRefusedError) return refused(e.message, e.status);
      return refused(e instanceof Error ? e.message : String(e), 403);
    }
  });
}
