import { test } from "node:test";
import assert from "node:assert/strict";

import { coolifyApplication } from "./applications";
import { APP } from "./map-test-helpers";

test("a short repository is joined to the host its source lives on", () => {
  const short = coolifyApplication({
    ...APP,
    git_repository: "mdn/beginner-html-site",
    source_type: "App\\Models\\GithubApp",
  });
  assert.equal(
    short.customGitUrl,
    "https://github.com/mdn/beginner-html-site.git",
  );

  const gitlab = coolifyApplication({
    ...APP,
    git_repository: "group/sub/app",
    source_type: "App\\Models\\GitlabApp",
  });
  assert.equal(gitlab.customGitUrl, "https://gitlab.com/group/sub/app.git");

  const own = coolifyApplication({
    ...APP,
    git_repository: "team/app",
    source_type: "App\\Models\\GiteaApp",
    source: { html_url: "https://git.acme.com/" },
  });
  assert.equal(own.customGitUrl, "https://git.acme.com/team/app.git");

  assert.equal(
    coolifyApplication(APP).customGitUrl,
    "https://github.com/acme/web",
  );
  assert.equal(
    coolifyApplication({ ...APP, git_repository: "git@git.acme.com:t/a.git" })
      .customGitUrl,
    "git@git.acme.com:t/a.git",
  );
});

test("a repository behind a source keeps the provider it sat behind", () => {
  assert.equal(
    coolifyApplication({
      ...APP,
      git_repository: "IdraDev/creator_wars",
      git_branch: "master",
      source_type: "App\\Models\\GithubApp",
    }).sourceType,
    "github",
  );
  assert.equal(
    coolifyApplication({
      ...APP,
      git_repository: "team/app",
      source_type: "App\\Models\\GiteaApp",
      source: { html_url: "https://git.acme.com/" },
    }).sourceType,
    "gitea",
  );
  assert.equal(coolifyApplication(APP).sourceType, "git");
  assert.equal(
    coolifyApplication({ ...APP, git_repository: "git@git.acme.com:t/a.git" })
      .sourceType,
    "git",
  );
});

test("a repository with no source at all says github was assumed", () => {
  const a = coolifyApplication({ ...APP, git_repository: "acme/web" });
  assert.equal(a.customGitUrl, "https://github.com/acme/web.git");
  assert.equal(a.sourceType, "github");
  assert.ok(
    a.platformNotes?.some((n) => n.includes("Change it under Source")),
    "the guess has to be said out loud",
  );
});
