import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { resolveInstallationAccount } from "@/lib/github/app";
import { readConnectState } from "@/lib/github/manifest";
import { upsertInstallation } from "@/lib/data/github";
import { resolvePublicBaseUrl } from "@/lib/public-url";

/**
 * Post-install redirect. GitHub sends the user here after they install (or
 * update) the App, with `installation_id`. We resolve which connected App owns
 * it, read the account it was installed on, and record the installation so its
 * repositories become available as deploy sources.
 *
 * The `state` here is NOT a CSRF check: an install started on github.com (or
 * `setup_on_update`, when someone edits repository access later) carries none,
 * and refusing those would break a legitimate flow. It is only the return
 * address the connect flow put on the installation URL, so someone who started
 * from the create-app wizard lands back in the wizard instead of on
 * Settings → Git. Unsigned, expired or another user's state simply means "no
 * return address" and the flow ends where it always did.
 *
 * A forged/replayed `installation_id` is defused downstream instead: this
 * handler requires an authenticated session (below), and `upsertInstallation`
 * re-gates on `manage_git` AND verifies the resolved App belongs to the
 * caller's active team, so a foreign installation_id resolves to an App the
 * caller cannot write and is rejected. Do not treat the raw param as
 * authorization on its own.
 */
export async function GET(request: NextRequest) {
  // Build redirects against the public base URL, NOT request.nextUrl.origin:
  // behind a reverse proxy the latter is the internal origin (e.g.
  // http://localhost:3000), which would send the browser to the wrong host.
  const origin = resolvePublicBaseUrl(request.headers);
  const settings = new URL("/settings/git", origin);

  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/login", origin));

  const idParam = request.nextUrl.searchParams.get("installation_id");
  const installationId = Number(idParam);
  if (!idParam || !Number.isInteger(installationId) || installationId <= 0) {
    settings.searchParams.set("git", "error");
    return NextResponse.redirect(settings);
  }

  try {
    const resolved = await resolveInstallationAccount(installationId);
    if (!resolved) {
      settings.searchParams.set("git", "error");
      return NextResponse.redirect(settings);
    }
    await upsertInstallation({
      appDbId: resolved.app.id,
      installationId: resolved.account.installationId,
      accountLogin: resolved.account.accountLogin,
      accountType: resolved.account.accountType,
      avatarUrl: resolved.account.avatarUrl,
    });
    // Back where the connect started, with the same one-shot flag the panel
    // uses — the toast lives in the app shell, so it fires on any page.
    const back =
      readConnectState(request.nextUrl.searchParams.get("state"), user.id)
        ?.returnTo ?? null;
    const done = back ? new URL(back, origin) : settings;
    done.searchParams.set("git", "connected");
    return NextResponse.redirect(done);
  } catch {
    settings.searchParams.set("git", "error");
    return NextResponse.redirect(settings);
  }
}
