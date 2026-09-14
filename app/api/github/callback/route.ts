import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import {
  exchangeManifestCode,
  readConnectState,
  signConnectState,
} from "@/lib/github/manifest";
import { createGithubApp } from "@/lib/data/github";
import { resolvePublicBaseUrl } from "@/lib/public-url";

// GET is GitHub's App-manifest callback: a one-time `code` plus the `state` we issued.
export async function GET(request: NextRequest) {
  // Not request.nextUrl.origin: behind a reverse proxy that is the internal origin, so redirects would leave the public host.
  const origin = resolvePublicBaseUrl(request.headers);
  const settings = new URL("/settings/git", origin);

  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/login", origin));

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");

  const started = readConnectState(state, user.id);
  if (!started) {
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
    const install = new URL(`${conversion.html_url}/installations/new`);
    if (started.returnTo) {
      install.searchParams.set(
        "state",
        signConnectState(user.id, started.returnTo),
      );
    }
    return NextResponse.redirect(install);
  } catch {
    settings.searchParams.set("git", "error");
    return NextResponse.redirect(settings);
  }
}
