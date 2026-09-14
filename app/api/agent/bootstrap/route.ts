import { completeBootstrap } from "@/lib/data/servers/agent-handshake";
import { signResponse, BootstrapError } from "@/lib/agent/bootstrap";
import { readTextCapped } from "@/lib/http/body-cap";

// POST is the agent call-home bootstrap: the agent pinned our cert fingerprint over HTTPS, and over plain HTTP the response HMAC below is its only proof of us.
export async function POST(request: Request) {
  let body: {
    token?: unknown;
    csrPem?: unknown;
    agentPort?: unknown;
    advertisedHost?: unknown;
  };
  const raw = await readTextCapped(request);
  if (raw instanceof Response) return raw;
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token : "";
  const csrPem = typeof body.csrPem === "string" ? body.csrPem : "";
  if (!token || !csrPem) {
    return Response.json(
      { error: "token and csrPem are required" },
      { status: 400 },
    );
  }
  const agentPort =
    typeof body.agentPort === "number" ? body.agentPort : undefined;
  const advertisedHost =
    typeof body.advertisedHost === "string" ? body.advertisedHost : undefined;

  try {
    const { certPem, caPem } = await completeBootstrap({
      token,
      csrPem,
      agentPort,
      advertisedHost,
    });
    // The agent recomputes this HMAC and refuses a mismatch, binding the CA it carries to a party that knew the token.
    const payload = JSON.stringify({ certPem, caPem });
    const mac = signResponse(token, payload);
    return new Response(payload, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-deplo-bootstrap-mac": mac,
      },
    });
  } catch (e) {
    if (e instanceof BootstrapError) {
      // The reason code is all we reveal: it leaks neither the token nor which server.
      return Response.json({ error: e.reason }, { status: 401 });
    }
    // A lost race (token consumed concurrently) or unexpected failure.
    return Response.json(
      { error: e instanceof Error ? e.message : "bootstrap failed" },
      { status: 409 },
    );
  }
}
