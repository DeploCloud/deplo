import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import {
  exchangeManifestCode,
  readConnectState,
  signConnectState,
} from "@/lib/github/manifest";
import { createGithubApp } from "@/lib/data/github";
import { completeGithubUserAuthorize } from "@/lib/data/github-user";
import { readUserAuthorizeState } from "@/lib/github/user-token";
import { resolveManifestBaseUrl, resolvePublicBaseUrl } from "@/lib/public-url";
import { refuseWhileFrozen } from "@/lib/data/deplo-move/freeze";

export async function GET(request: NextRequest) {
  const paused = await refuseWhileFrozen();
  if (paused) return paused;
  const origin = resolvePublicBaseUrl(request.headers);
  const settings = new URL("/settings/git", origin);

  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/login", origin));

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");

  // A person signing in to GitHub to create a repository in their own account.
  const signIn = readUserAuthorizeState(state, user.id);
  if (signIn) {
    const back = new URL(signIn.returnTo ?? "/new", origin);
    if (!code) back.searchParams.set("github", "denied");
    else {
      const ok = await completeGithubUserAuthorize(
        signIn.appId,
        code,
        resolveManifestBaseUrl(),
      ).then(
        () => true,
        () => false,
      );
      if (!ok) back.searchParams.set("github", "error");
    }
    return NextResponse.redirect(back);
  }

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
