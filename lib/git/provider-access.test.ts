import { test } from "node:test";
import assert from "node:assert/strict";

import { buildManifest } from "../github/manifest";
import {
  githubGranted,
  githubManifestAccess,
  gitlabGranted,
  grantedFromScopes,
  missingAccess,
  requiredAccess,
  tokenScopesLine,
} from "./provider-access";

test("a GitHub level satisfies every level below it", () => {
  const granted = githubGranted(
    { contents: "write", metadata: "read", pull_requests: "write" },
    ["push", "pull_request"],
  );
  assert.ok(granted.has("contents:read"), "write covers read");
  assert.ok(granted.has("contents:write"));
  assert.ok(!granted.has("contents:admin"), "and nothing above it");
  assert.deepEqual(missingAccess("github", granted, { previews: true }), []);
});

test("what GitHub is missing is named, split by feature", () => {
  const granted = githubGranted({ contents: "read", metadata: "read" }, [
    "push",
  ]);
  assert.deepEqual(missingAccess("github", granted), [], "core is complete");

  const withPreviews = missingAccess("github", granted, { previews: true });
  assert.deepEqual(
    withPreviews.map((r) => r.key),
    ["pull_requests:write", "event:pull_request"],
  );
  // The label is the provider's own, not ours: it has to match the screen.
  assert.equal(withPreviews[0]!.label, "Pull requests: Read and write");

  assert.deepEqual(
    missingAccess("github", githubGranted({}, [])).map((r) => r.key),
    ["metadata:read", "contents:read", "event:push"],
  );
});

test("a provider that reports nothing is never accused", () => {
  // Bitbucket and Gitea do not expose their token's scopes: null in, empty out, so the UI shows a checklist and never a warning.
  assert.equal(grantedFromScopes("gitea", ""), null);
  assert.equal(grantedFromScopes("bitbucket", "   "), null);
  assert.deepEqual(missingAccess("gitea", null), []);
  assert.deepEqual(missingAccess("bitbucket", null, { previews: true }), []);
  // But an EMPTY set is a real answer: the token genuinely has none of them.
  assert.equal(missingAccess("gitea", new Set()).length, 2);
});

test("GitLab's api scope is the superset it claims to be", () => {
  assert.deepEqual(missingAccess("gitlab", gitlabGranted(["api"])), []);
  assert.deepEqual(
    missingAccess("gitlab", grantedFromScopes("gitlab", "api")),
    [],
  );
  // read_repository alone still cannot register the webhook.
  assert.deepEqual(
    missingAccess("gitlab", gitlabGranted(["read_repository"])).map(
      (r) => r.key,
    ),
    ["api"],
  );
});

test("the manifest asks for exactly what the check requires", () => {
  // The drift this stops: an App created without something Deplo then warns about, or a warning about something it never asked for.
  const { permissions, events } = githubManifestAccess();
  const granted = githubGranted(permissions, events);
  assert.deepEqual(missingAccess("github", granted, { previews: true }), []);

  const manifest = buildManifest("https://deplo.example.com");
  assert.deepEqual(
    missingAccess(
      "github",
      githubGranted(manifest.default_permissions, manifest.default_events),
      { previews: true },
    ),
    [],
  );
});

test("the connect dialog's scopes line is the requirement list", () => {
  assert.equal(tokenScopesLine("gitlab"), "read_repository, api");
  assert.equal(tokenScopesLine("git"), "", "a plain git server asks nothing");
  assert.deepEqual(
    requiredAccess("bitbucket").map((r) => r.feature),
    ["core", "core"],
  );
});
