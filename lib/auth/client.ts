"use client";

import { createAuthClient } from "better-auth/react";
import { twoFactorClient } from "better-auth/client/plugins";

/**
 * Better Auth's browser client, used for ONE thing: two-factor enrolment.
 *
 * Every other mutation in deplo goes through GraphQL. This is the sanctioned
 * exception, for the same reason `/api/auth/*` already is one: the twoFactor
 * plugin's enrol / verify / disable / regenerate flow is a stateful multi-step
 * exchange that carries its own short-lived cookies, and wrapping four endpoints
 * in four resolvers would add a translation layer without adding a gate — the
 * endpoints are already session-authenticated and password-gated by the plugin.
 *
 * Same-origin, so no `baseURL`: the client posts to `/api/auth/*` on whatever
 * host the app is served from, which is what makes it work behind any domain the
 * operator points at the instance.
 */
export const authClient = createAuthClient({
  plugins: [twoFactorClient()],
});
