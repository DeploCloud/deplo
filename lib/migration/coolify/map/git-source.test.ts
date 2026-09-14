import { test } from "node:test";
import assert from "node:assert/strict";

import { coolifyApplication } from "./applications";
import { APP } from "./map-test-helpers";

test("a short repository is joined to the host its source lives on", () => {
  // A public repo carries a whole URL; one behind a source carries `owner/repo`, and `git clone mdn/beginner-html-site` is what that became.
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

  // A self-hosted source names its own host, and that always wins.
  const own = coolifyApplication({
    ...APP,
    git_repository: "team/app",
    source_type: "App\\Models\\GiteaApp",
    source: { html_url: "https://git.acme.com/" },
  });
  assert.equal(own.customGitUrl, "https://git.acme.com/team/app.git");

  // A whole URL is kept byte for byte, and so is an ssh remote.
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
  // Coolify hands over `owner/repo` and the source, never the credential: read as plain git the clone went out anonymous and died on "could not read Username".
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
  // A whole address clones here exactly as it cloned there, so naming a provider would only ask for a credential that was never needed.
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
  // The provider follows the address that was just invented: plain git would send an anonymous clone at a host Deplo picked and report git's error.
  assert.equal(a.sourceType, "github");
  assert.ok(
    a.platformNotes?.some((n) => n.includes("Change it under Source")),
    "the guess has to be said out loud",
  );
});
