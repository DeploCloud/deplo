import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { verifyState } from "@/lib/crypto";
import { exchangeManifestCode } from "@/lib/github/manifest";
import { createGithubApp } from "@/lib/data/github";
import { resolvePublicBaseUrl } from "@/lib/public-url";

/**
 * GitHub App manifest callback. GitHub redirects here after the user creates
 * the App, with a one-time `code` and the `state` we issued. We verify the
 * state (CSRF), exchange the code for the App's credentials, persist them, and
 * send the user on to install the App on their account.
 */
export async function GET(request: NextRequest) {
  // Public base URL, not request.nextUrl.origin: behind a reverse proxy the
  // latter is the internal origin (e.g. http://localhost:3000), which would
  // send the browser to the wrong host on the error/login redirects.
  const origin = resolvePublicBaseUrl(request.headers);
  const settings = new URL("/settings/git", origin);

  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/login", origin));

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");

  if (verifyState(state ?? undefined) !== `github:${user.id}`) {
    settings.searchParams.set("git", "state_error");
    return NextResponse.redirect(settings);
  }
  if (!code) {
    settings.searchParams.set("git", "error");
    return NextResponse.redirect(settings);
  }

  try {
    const conversion = await exchangeManifestCode(code);
    await createGithubApp(conversion);
    // Straight on to installing the App on the user's account/repos.
    return NextResponse.redirect(
      new URL(`${conversion.html_url}/installations/new`),
    );
  } catch {
    settings.searchParams.set("git", "error");
    return NextResponse.redirect(settings);
  }
}
