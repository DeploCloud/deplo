import { agentBinary } from "@/lib/agent/install-script";

/**
 * Serve the `deplo-agent` binary (PLAN Part B, P2). Public + unauthenticated:
 * the install script downloads it on the target server. The script verifies the
 * sha256 (substituted into it from the SAME bytes) before executing, so a
 * tampered binary is rejected at the operator's end. This is the exact binary
 * the control plane runs as its own local agent, so versions never skew.
 */
export async function GET() {
  let bytes: Buffer;
  try {
    ({ bytes } = await agentBinary());
  } catch {
    return new Response("agent binary unavailable", { status: 503 });
  }
  // Buffer -> a fresh Uint8Array view so the Response body is a clean ArrayBuffer.
  const body = new Uint8Array(bytes);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="deplo-agent"',
      "content-length": String(body.byteLength),
      "cache-control": "no-store",
    },
  });
}
