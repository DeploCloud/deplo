// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { resolveLatestAgentRelease } from "@/lib/agent/release";

/**
 * Redirect to the agent binary on GitHub Releases (DeploCloud/deplo-agent).
 */
export async function GET(req: Request) {
  const arch =
    new URL(req.url).searchParams.get("arch") === "arm64" ? "arm64" : "amd64";
  const release = await resolveLatestAgentRelease();
  const target = release?.binaries[arch]?.url;
  if (!target) {
    return new Response("agent binary unavailable", { status: 503 });
  }
  return Response.redirect(target, 302);
}
