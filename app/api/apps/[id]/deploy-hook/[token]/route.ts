import { authenticateToken } from "@/lib/data/tokens";
import { appInTeam } from "@/lib/data/app-graph-load";
import { verifyDeployHookToken } from "@/lib/data/deploy-hook";
import { redeploy } from "@/lib/data/deployments";
import { runWithIdentity } from "@/lib/auth/request-context";
import { owningTeamId } from "@/lib/data/deploy-hook";

/**
 * The deploy hook: `POST /api/apps/<id>/deploy-hook/<token>` deploys the app.
 *
 *   curl -X POST -H "Authorization: Bearer deplo_…" \
 *     https://deplo.example.com/api/apps/prj_123/deploy-hook/<token>
 *
 * TWO secrets, on purpose (see lib/data/deploy-hook.ts). The URL's last segment
 * says WHICH app — rotatable, and useless on its own. The bearer API token says
 * WHO — it resolves to a real member, and the deploy then runs through the exact
 * same gates the dashboard button does (`redeploy` re-checks the team, the folder
 * grant, `deploy_apps` and the two-factor policy), so a hook can never do more
 * than the person whose token it carries. Revoking that token stops every hook
 * call made with it everywhere, without touching a single app's settings.
 *
 * REST rather than GraphQL because a webhook sender — GitLab, a CI runner, a
 * registry — posts to a URL it is given and cannot compose a query. It is the
 * one endpoint here authenticated by bearer token INSTEAD of the session cookie;
 * every other app route under /api/apps is cookie-authenticated.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Opening the hook URL in a browser is the first thing anyone does with it, and
 * a bare 405 renders as the browser's own "this page isn't working" — which
 * reads as "Deplo is broken", not "you used the wrong verb".
 *
 * So GET answers in JSON, saying what to do instead. It deliberately answers the
 * SAME thing for every URL under this path: it never looks at the app or the
 * token, so it can't become an oracle for guessing either. It also never
 * deploys — a deploy from a GET would fire on every link preview, prefetch and
 * security scanner that ever touched the URL.
 *
 * 405 (with the `Allow` header RFC 9110 requires) rather than 200: the request
 * genuinely was not acceptable, and a 200 here would make a "test my URL" click
 * look like a working deploy.
 */
export async function GET() {
  return Response.json(
    {
      error:
        "Method not allowed. A deploy hook is triggered with POST, and the call " +
        'must carry an API token: `Authorization: Bearer deplo_…`. Create one in ' +
        "Settings → API tokens.",
      example: 'curl -X POST -H "Authorization: Bearer deplo_your_token" <this url>',
    },
    { status: 405, headers: { Allow: "POST" } },
  );
}

export async function POST(
  request: Request,
  // Spelled out rather than `RouteContext<"…">`: that generated type only exists
  // after a build has run, and this file must typecheck before one has.
  ctx: { params: Promise<{ id: string; token: string }> },
) {
  // The bearer token comes FIRST: until the caller has proved they are a member
  // of some team, the URL token must not be able to tell them whether an app
  // exists, or whether its hook is switched off.
  const header = request.headers.get("authorization") ?? "";
  // The scheme is case-INSENSITIVE (RFC 9110 §11.1) and `lib/graphql/context.ts`
  // already treats it that way. Matching `Bearer ` exactly here meant a sender
  // that writes `bearer` — some CI runners and HTTP clients do — got a 401 from
  // the hook while the same credential worked on /api/graphql.
  const raw = /^bearer /i.test(header) ? header.slice(7).trim() : "";
  const { id: hookAppId } = await ctx.params;
  // A token's scope can span teams, so say which one this call is about: the
  // team that owns the app in the URL. An un-gated id → team_id lookup, which
  // leaks nothing on its own — every check below still runs as the token.
  // A token whose member is under an unmet two-factor policy makes
  // `authenticateToken` THROW rather than answer — it is a refusal with a reason
  // ("the X role requires two-factor authentication"), and a CI job debugging a
  // suddenly-failing hook deserves to read it instead of a bare 500.
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
          "Missing or invalid API token. Send an `Authorization: Bearer deplo_…` header — create the token in Settings → API tokens.",
      },
      { status: 401 },
    );

  const { token } = await ctx.params;
  const appId = hookAppId;
  // Everything from here runs as the token, so an app its project scope excludes
  // answers exactly like an app that isn't there. The reachability check has to
  // come BEFORE the "hook is off" branch, or the 403 stays an existence oracle.
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
    // A wrong token and an unknown app answer identically: a caller holding a
    // token for team A must not be able to probe team B's app ids.
    return Response.json({ error: "Deploy hook not found" }, { status: 404 });
  }
  if (hook.teamId !== principal.teamId)
    return Response.json({ error: "Deploy hook not found" }, { status: 404 });

  try {
    // Back onto the normal path: inside runWithIdentity the whole data layer
    // resolves this API token's grant, so `redeploy` applies every gate — no
    // capability check is duplicated here, and none can be skipped.
    const deployment = await runWithIdentity(principal, () => redeploy(appId));
    return Response.json({
      deploymentId: deployment.id,
      appId,
      status: deployment.status,
      url: deployment.url || null,
    });
  } catch (e) {
    // `redeploy` throws for a real reason the caller can act on — no
    // `deploy_apps`, no access to the app's folder, two-factor required.
    return Response.json({ error: (e as Error).message }, { status: 403 });
  }
}
