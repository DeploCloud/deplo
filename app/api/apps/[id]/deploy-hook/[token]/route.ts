import { authenticateToken } from "@/lib/data/tokens/authenticate";
import { appInTeam } from "@/lib/data/app-graph-load";
import { verifyDeployHookToken } from "@/lib/data/deploy-hook";
import { redeploy } from "@/lib/data/deployments/stack-actions";
import { runWithIdentity } from "@/lib/auth/request-context";
import { owningTeamId } from "@/lib/data/deploy-hook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    {
      error:
        "Method not allowed. A deploy hook is triggered with POST, and the call " +
        "must carry an API token: `Authorization: Bearer deplo_…`. Create one in " +
        "Settings → API tokens.",
      example:
        'curl -X POST -H "Authorization: Bearer deplo_your_token" <this url>',
    },
    { status: 405, headers: { Allow: "POST" } },
  );
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; token: string }> },
) {
  // Bearer first: until the caller proves team membership, the URL token must not reveal whether an app exists.
  const header = request.headers.get("authorization") ?? "";
  const raw = /^bearer /i.test(header) ? header.slice(7).trim() : "";
  const { id: hookAppId } = await ctx.params;
  let principal = null;
  let refusal = "";
  try {
    principal = raw
      ? await authenticateToken(raw, await owningTeamId(hookAppId))
      : null;
  } catch (e) {
    refusal = (e as Error).message;
  }
  if (!principal)
    return Response.json(
      {
        error:
          refusal ||
          "Missing or invalid API token. Send an `Authorization: Bearer deplo_…` header - create the token in Settings → API tokens.",
      },
      { status: 401 },
    );

  const { token } = await ctx.params;
  const appId = hookAppId;
  // Checked BEFORE the "hook is off" branch, or that 403 stays an existence oracle.
  const notFound = await runWithIdentity(principal, async () => {
    if (!(await appInTeam(appId, principal.teamId))) return true;
    return false;
  });
  if (notFound)
    return Response.json({ error: "Deploy hook not found" }, { status: 404 });

  const hook = await verifyDeployHookToken(appId, token);
  if (!hook.ok) {
    if (hook.reason === "disabled")
      return Response.json(
        {
          error:
            "This app's deploy hook is turned off. Turn it back on in the app's Deployment settings.",
        },
        { status: 403 },
      );
    return Response.json({ error: "Deploy hook not found" }, { status: 404 });
  }
  if (hook.teamId !== principal.teamId)
    return Response.json({ error: "Deploy hook not found" }, { status: 404 });

  try {
    // redeploy applies every gate inside runWithIdentity; duplicating a capability check here is a bug.
    const deployment = await runWithIdentity(principal, () => redeploy(appId));
    return Response.json({
      deploymentId: deployment.id,
      appId,
      status: deployment.status,
      url: deployment.url || null,
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 403 });
  }
}
