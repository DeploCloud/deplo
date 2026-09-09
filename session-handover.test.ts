import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * A sign-in, a sign-out or a first team changes what the server answers for `/`,
 * and every payload the client router cached was rendered for the session before
 * it - `/` included, which the login page's own logo prefetches into a redirect
 * back to /login. Hand over with a full navigation, never with the router.
 */
const HANDOVERS = [
  "app/(auth)/login/page.tsx",
  "app/register/[token]/register-wizard.tsx",
  "components/auth/onboarding-wizard.tsx",
  "components/teams/welcome-create-team.tsx",
  "components/layout/user-menu.tsx",
  "components/oauth/consent-form.tsx",
  "components/settings/security/two-factor-lock-screen.tsx",
];

test("every session hand-over is a full navigation", () => {
  for (const file of HANDOVERS) {
    const src = readFileSync(file, "utf8");
    assert.match(
      src,
      /window\.location\.assign\(/,
      `${file}: hands over with the router`,
    );
    assert.doesNotMatch(
      src,
      /router\.(push|refresh)\(/,
      `${file}: still calls the router`,
    );
  }
});
