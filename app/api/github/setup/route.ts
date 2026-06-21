import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { resolveInstallationAccount } from "@/lib/github/app";
import { upsertInstallation } from "@/lib/data/github";
import { resolvePublicBaseUrl } from "@/lib/public-url";

/**
 * Post-install redirect. GitHub sends the user here after they install (or
 * update) the App, with `installation_id`. We resolve which connected App owns
 * it, read the account it was installed on, and record the installation so its
 * repositories become available as deploy sources.
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
    settings.searchParams.set("git", "connected");
    return NextResponse.redirect(settings);
  } catch {
    settings.searchParams.set("git", "error");
    return NextResponse.redirect(settings);
  }
}
