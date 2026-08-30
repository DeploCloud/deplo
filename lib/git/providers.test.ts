// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { PROVIDERS, providerFor, tokenHelpUrl } from "./providers";
import { shouldAutoDeploy } from "../deploy/git-webhook";

/**
 * The two things a provider adapter must not get subtly wrong: deciding a delivery
 * is authentic, and turning that delivery into the ref/tag/file-list shape the
 * (already tested) auto-deploy rules read.
 */

const SECRET = "s3cr3t-webhook";
const hmac = (body: string) =>
  createHmac("sha256", SECRET).update(body).digest("hex");

const headers = (h: Record<string, string>) => new Headers(h);

const api = (id: "gitlab" | "bitbucket" | "gitea") => {
  const a = PROVIDERS[id].api;
  assert.ok(a, `${id} has an API`);
  return a;
};

/* ---- verification ---------------------------------------------------- */

test("gitlab: the shared token must match exactly", () => {
  const gl = api("gitlab");
  assert.equal(
    gl.verify(SECRET, headers({ "x-gitlab-token": SECRET }), ""),
    "ok",
  );
  assert.equal(
    gl.verify(SECRET, headers({ "x-gitlab-token": "nope" }), ""),
    "bad",
  );
  // A missing header is a forgery, not an unsigned delivery: GitLab always sends
  // back the token it was configured with.
  assert.equal(gl.verify(SECRET, headers({}), ""), "bad");
});

test("gitea: hex HMAC in its own header, or GitHub's prefixed one", () => {
  const gt = api("gitea");
  const body = '{"ref":"refs/heads/main"}';
  assert.equal(
    gt.verify(SECRET, headers({ "x-gitea-signature": hmac(body) }), body),
    "ok",
  );
  assert.equal(
    gt.verify(
      SECRET,
      headers({ "x-hub-signature-256": `sha256=${hmac(body)}` }),
      body,
    ),
    "ok",
  );
  // A signature over a different body must not pass.
  assert.equal(
    gt.verify(SECRET, headers({ "x-gitea-signature": hmac("other") }), body),
    "bad",
  );
  assert.equal(gt.verify(SECRET, headers({}), body), "bad");
});

test("bitbucket: signed when a secret is set, 'unsigned' when it is not", () => {
  const bb = api("bitbucket");
  const body = '{"push":{}}';
  assert.equal(
    bb.verify(
      SECRET,
      headers({ "x-hub-signature": `sha256=${hmac(body)}` }),
      body,
    ),
    "ok",
  );
  assert.equal(
    bb.verify(SECRET, headers({ "x-hub-signature": "sha256=deadbeef" }), body),
    "bad",
  );
  // No header at all: Bitbucket only signs when a secret is configured on its
  // side, so the unguessable token in the delivery URL is what authenticates it.
  assert.equal(bb.verify(SECRET, headers({}), body), "unsigned");
});

/* ---- push parsing ---------------------------------------------------- */

test("gitlab: a branch push carries its ref, files and newest message", () => {
  const [p] = api("gitlab").parsePush(
    headers({ "x-gitlab-event": "Push Hook" }),
    {
      ref: "refs/heads/main",
      after: "abc1234",
      project: { path_with_namespace: "acme/site" },
      user_username: "rita",
      commits: [
        { message: "first", added: ["a.ts"] },
        { message: "second line\nbody", modified: ["src/b.ts"] },
      ],
    },
  );
  assert.equal(p.repoFullName, "acme/site");
  assert.equal(p.author, "rita");
  assert.equal(p.commitMessage, "second line");
  assert.equal(p.event.refName, "main");
  assert.equal(p.event.isTag, false);
  assert.equal(p.event.deleted, false);
  assert.deepEqual([...p.event.changedPaths].sort(), ["a.ts", "src/b.ts"]);
});

test("gitlab: an all-zero after sha is a branch deletion", () => {
  const [p] = api("gitlab").parsePush(
    headers({ "x-gitlab-event": "Push Hook" }),
    {
      ref: "refs/heads/gone",
      after: "0000000000000000000000000000000000000000",
      project: { path_with_namespace: "acme/site" },
    },
  );
  assert.equal(p.event.deleted, true);
  // …and a deletion never deploys, whatever else is configured.
  assert.equal(
    shouldAutoDeploy(
      { branch: "gone", triggerType: "push", watchPaths: [] },
      p.event,
    ),
    false,
  );
});

test("gitlab: a tag push is flagged as a tag", () => {
  const [p] = api("gitlab").parsePush(
    headers({ "x-gitlab-event": "Tag Push Hook" }),
    {
      ref: "refs/tags/v2.0.0",
      after: "abc",
      project: { path_with_namespace: "acme/site" },
    },
  );
  assert.equal(p.event.isTag, true);
  assert.equal(p.event.refName, "v2.0.0");
});

test("gitlab: a non-push event yields nothing", () => {
  assert.deepEqual(
    api("gitlab").parsePush(headers({ "x-gitlab-event": "Issue Hook" }), {
      ref: "refs/heads/main",
      project: { path_with_namespace: "acme/site" },
    }),
    [],
  );
});

test("gitea: the GitHub-shaped payload parses like GitHub's", () => {
  const [p] = api("gitea").parsePush(headers({ "x-gitea-event": "push" }), {
    ref: "refs/heads/develop",
    repository: { full_name: "acme/api" },
    pusher: { username: "luca" },
    head_commit: { message: "fix: thing" },
    commits: [{ added: ["cmd/main.go"] }],
  });
  assert.equal(p.repoFullName, "acme/api");
  assert.equal(p.author, "luca");
  assert.equal(p.commitMessage, "fix: thing");
  assert.equal(p.event.refName, "develop");
  assert.deepEqual(p.event.changedPaths, ["cmd/main.go"]);
});

test("bitbucket: every moved ref becomes its own event", () => {
  const out = api("bitbucket").parsePush(
    headers({ "x-event-key": "repo:push" }),
    {
      repository: { full_name: "team/app" },
      actor: { nickname: "sam" },
      push: {
        changes: [
          {
            new: {
              type: "branch",
              name: "main",
              target: { message: "ship it" },
            },
          },
          { new: { type: "tag", name: "v1.0.0", target: { message: "tag" } } },
          { new: null, old: { name: "stale" } },
        ],
      },
    },
  );
  assert.equal(out.length, 3);
  assert.equal(out[0].event.refName, "main");
  assert.equal(out[0].event.isTag, false);
  assert.equal(out[0].commitMessage, "ship it");
  assert.equal(out[1].event.isTag, true);
  assert.equal(out[2].event.deleted, true);
  assert.equal(out[2].event.refName, "stale");
});

test("bitbucket: no file list means path filters fall open", () => {
  const [p] = api("bitbucket").parsePush(
    headers({ "x-event-key": "repo:push" }),
    {
      repository: { full_name: "team/app" },
      push: {
        changes: [{ new: { type: "branch", name: "main", target: {} } }],
      },
    },
  );
  assert.deepEqual(p.event.changedPaths, []);
  // Bitbucket sends no changed files, so a watch-path allowlist cannot be
  // evaluated and must NOT silently block every deploy.
  assert.equal(
    shouldAutoDeploy(
      { branch: "main", triggerType: "push", watchPaths: ["apps/**"] },
      p.event,
    ),
    true,
  );
});

test("bitbucket: a non-push event key yields nothing", () => {
  assert.deepEqual(
    api("bitbucket").parsePush(
      headers({ "x-event-key": "pullrequest:created" }),
      {
        repository: { full_name: "team/app" },
      },
    ),
    [],
  );
});

/* ---- catalogue ------------------------------------------------------- */

test("plain git carries credentials and nothing else", () => {
  assert.equal(PROVIDERS.git.api, null);
  // Anything unrecognised degrades to it rather than throwing.
  assert.equal(providerFor("svn"), PROVIDERS.git);
});

test("the token help link resolves against a self-hosted base URL", () => {
  assert.equal(
    tokenHelpUrl("gitea", "https://git.acme.com/"),
    "https://git.acme.com/user/settings/applications",
  );
  assert.equal(
    tokenHelpUrl("bitbucket", "https://bitbucket.org"),
    "https://bitbucket.org/account/settings/app-passwords/",
  );
  assert.equal(tokenHelpUrl("git", "https://git.acme.com"), "");
});

/**
 * A secret that no longer decrypts (`decryptSecret` fails closed to `""` after a
 * `DEPLO_SECRET` rotation) must never verify. The route refuses on an empty secret
 * before any of them is called, and this is the second lock on the same door.
 */
test("an empty secret never verifies, whatever arrives", () => {
  const headers = (h: Record<string, string>) => new Headers(h);
  assert.equal(
    PROVIDERS.gitlab.api!.verify("", headers({ "x-gitlab-token": "" }), ""),
    "bad",
  );
  assert.equal(
    PROVIDERS.gitlab.api!.verify(
      "",
      headers({ "x-gitlab-token": "guess" }),
      "",
    ),
    "bad",
  );
  // A real secret still matches, so the guard did not simply break verification.
  assert.equal(
    PROVIDERS.gitlab.api!.verify(
      "s3cret",
      headers({ "x-gitlab-token": "s3cret" }),
      "",
    ),
    "ok",
  );
});
