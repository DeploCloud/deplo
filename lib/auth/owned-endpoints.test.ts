import { test } from "node:test";
import assert from "node:assert/strict";

import { isDeploOwnedAuthPath } from "./better-auth";

/**
 * `app/api/auth/[...all]/route.ts` mounts Better Auth WHOLE, because the OAuth
 * surface has to be reachable.
 */

test("the account surface deplo drives itself is shut", () => {
  for (const path of [
    "/sign-in/email",
    "/sign-in/social",
    "/sign-up/email",
    "/change-password",
    "/set-password",
    "/change-email",
    "/update-user",
    "/delete-user",
    "/list-sessions",
    "/revoke-session",
    "/revoke-sessions",
    "/revoke-other-sessions",
    "/forget-password",
    "/reset-password",
    "/request-password-reset",
  ]) {
    assert.equal(isDeploOwnedAuthPath(path), true, path);
  }
});

test("the OAuth surface stays open - a web AI client signs in through it", () => {
  for (const path of [
    "/oauth2/authorize",
    "/oauth2/token",
    "/oauth2/register",
    "/oauth2/consent",
    "/oauth2/userinfo",
  ]) {
    assert.equal(isDeploOwnedAuthPath(path), false, path);
  }
});

test("session reads and sign-out stay open - neither is a way IN", () => {
  for (const path of ["/get-session", "/sign-out", "/ok", "/error"]) {
    assert.equal(isDeploOwnedAuthPath(path), false, path);
  }
});
