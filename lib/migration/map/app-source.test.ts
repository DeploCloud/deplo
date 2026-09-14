import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cloneTarget,
  composeRegistryNotes,
  mapSource,
  repoNameFromUrl,
} from "./app-source";
import { app } from "./map-test-helpers";

test("mapSource builds an https clone URL for every git flavour", () => {
  assert.deepEqual(cloneTarget(app()), {
    provider: "github",
    url: "https://github.com/acme/web.git",
    repo: "acme/web",
    branch: "main",
  });

  assert.deepEqual(
    cloneTarget(
      app({
        sourceType: "gitlab",
        // Dokploy clones `<host>/<gitlabPathNamespace>.git`: the field is the FULL project path, repository included.
        gitlabPathNamespace: "acme/team/api",
        gitlabRepository: "api",
        gitlabBranch: "develop",
        gitlab: { gitlabUrl: "https://git.acme.com" },
      }),
    ),
    {
      provider: "gitlab",
      url: "https://git.acme.com/acme/team/api.git",
      repo: "acme/team/api",
      branch: "develop",
    },
  );

  assert.equal(
    cloneTarget(
      app({
        sourceType: "gitea",
        giteaOwner: "acme",
        giteaRepository: "svc",
        gitea: { giteaUrl: "code.acme.com" },
      }),
    )?.url,
    "https://code.acme.com/acme/svc.git",
  );

  assert.equal(
    cloneTarget(
      app({
        sourceType: "bitbucket",
        bitbucketOwner: "acme",
        bitbucketRepositorySlug: "thing",
      }),
    )?.url,
    "https://bitbucket.org/acme/thing.git",
  );

  assert.equal(
    cloneTarget(
      app({
        sourceType: "git",
        customGitUrl: "https://git.example.com/a/b.git",
      }),
    )?.repo,
    "a/b",
  );
});

test("a self-hosted git server behind a path prefix keeps the prefix", () => {
  assert.equal(
    cloneTarget(
      app({
        sourceType: "gitlab",
        gitlabPathNamespace: "acme/api",
        gitlabRepository: "api",
        gitlab: { gitlabUrl: "https://acme.test/gitlab/" },
      }),
    )?.url,
    "https://acme.test/gitlab/acme/api.git",
  );
  assert.equal(
    cloneTarget(
      app({
        sourceType: "gitea",
        giteaOwner: "acme",
        giteaRepository: "svc",
        gitea: { giteaUrl: "acme.test/git" },
      }),
    )?.url,
    "https://acme.test/git/acme/svc.git",
  );
});

test("mapSource falls back to the public host when the provider row is absent", () => {
  assert.equal(
    cloneTarget(
      app({
        sourceType: "gitlab",
        gitlabOwner: "acme",
        gitlabRepository: "api",
      }),
    )?.url,
    "https://gitlab.com/acme/api.git",
  );
});

test("mapSource always warns that no git credential came across", () => {
  const { value, notes } = mapSource(app());
  assert.equal(value.kind, "git");
  assert.match(notes.join(" "), /no credential/);
});

test("mapSource carries the git deploy options", () => {
  const { value } = mapSource(
    app({
      triggerType: "tag",
      watchPaths: ["apps/web/**", "  "],
      enableSubmodules: true,
    }),
  );
  assert.equal(value.kind, "git");
  if (value.kind !== "git") return;
  assert.equal(value.repo.triggerType, "tag");
  assert.deepEqual(value.repo.watchPaths, ["apps/web/**"]);
  assert.equal(value.repo.submodules, true);
});

test("mapSource takes a docker image and refuses one Deplo would interpolate", () => {
  const ok = mapSource(
    app({ sourceType: "docker", dockerImage: "ghcr.io/acme/api:1.2" }),
  );
  assert.deepEqual(ok.value, {
    kind: "docker-image",
    image: "ghcr.io/acme/api:1.2",
  });
  // A registry of its own and no credential: the panel may have pulled with a `docker login` nothing here can see.
  assert.match(ok.notes.join(" "), /Pulled from ghcr\.io/);

  const hub = mapSource(
    app({ sourceType: "docker", dockerImage: "nginx:alpine" }),
  );
  assert.deepEqual(hub.notes, [], "Docker Hub needs no login to say so");

  const bad = mapSource(
    app({ sourceType: "docker", dockerImage: "acme/api:1 && rm -rf /" }),
  );
  assert.deepEqual(bad.value, { kind: "none" });
  assert.match(bad.notes.join(" "), /not one Deplo accepts/);
});

test("mapSource reports a private registry, whose password never leaves Dokploy", () => {
  const { notes } = mapSource(
    app({
      sourceType: "docker",
      dockerImage: "reg.acme.com/api:1",
      registryId: "reg-1",
    }),
  );
  assert.match(notes.join(" "), /private registry/);

  // Credentials typed onto the application rather than picked from a registry used to come across looking like a public image.
  assert.match(
    mapSource(
      app({
        sourceType: "docker",
        dockerImage: "reg.acme.com/api:1",
        username: "robot",
        registryUrl: "reg.acme.com",
      }),
    ).notes.join(" "),
    /private registry/,
  );
});

test("mapSource flags an image that only exists on the source machine", () => {
  const { value, notes } = mapSource(
    app({
      sourceType: "docker",
      dockerImage: "localhost:5000/database-fdo:1.0",
    }),
  );
  // Still imported, but unpullable from here: "pull access denied" three days later points at the image, not at the migration.
  assert.deepEqual(value, {
    kind: "docker-image",
    image: "localhost:5000/database-fdo:1.0",
  });
  assert.match(notes.join(" "), /on the \{panel\} machine/);
});

test("mapSource cannot import an uploaded archive", () => {
  const { value, notes } = mapSource(app({ sourceType: "drop" }));
  assert.deepEqual(value, { kind: "none" });
  assert.match(notes.join(" "), /Upload it again here/);
});

test("repoNameFromUrl handles https and scp-style remotes", () => {
  assert.equal(repoNameFromUrl("https://github.com/acme/web.git"), "acme/web");
  assert.equal(repoNameFromUrl("git@github.com:acme/web.git"), "acme/web");
  assert.equal(
    repoNameFromUrl("ssh://git@git.acme.com:2222/acme/web"),
    "acme/web",
  );
});

test("a public repository is not reported as needing a credential", () => {
  const { notes } = mapSource({
    applicationId: "a1",
    sourceType: "git",
    buildType: "nixpacks",
    customGitUrl: "https://github.com/acme/public.git",
    customGitBranch: "main",
  } as Parameters<typeof mapSource>[0]);
  assert.deepEqual(notes, []);
});

test("a repository behind a connection still says a credential is needed", () => {
  const viaProvider = mapSource({
    applicationId: "a1",
    sourceType: "github",
    buildType: "nixpacks",
    owner: "acme",
    repository: "private",
    branch: "main",
  } as Parameters<typeof mapSource>[0]);
  // GitHub clones through an App, not a connection, so it is the App the line asks for.
  assert.ok(
    viaProvider.notes.some((n) => /Link a GitHub App/.test(n)),
    viaProvider.notes.join(" | "),
  );
  // The panel saying so itself (Coolify keeps a bare `owner/repo` behind a source) counts the same.
  const declared = mapSource({
    applicationId: "a2",
    sourceType: "gitea",
    buildType: "nixpacks",
    gitNeedsCredential: true,
    customGitUrl: "https://git.acme.com/acme/private.git",
    customGitBranch: "main",
  } as Parameters<typeof mapSource>[0]);
  assert.ok(
    declared.notes.some((n) => /Attach a git connection/.test(n)),
    declared.notes.join(" | "),
  );
});

test("a repository behind a source keeps that provider, with no credential", () => {
  // Coolify hands over `owner/repo` and the source, never the credential: read as plain git it died on git's "could not read Username".
  const gh = mapSource({
    applicationId: "a1",
    sourceType: "github",
    buildType: "nixpacks",
    gitNeedsCredential: true,
    customGitUrl: "https://github.com/IdraDev/creator_wars.git",
    customGitBranch: "master",
  } as Parameters<typeof mapSource>[0]);
  assert.equal(gh.value.kind, "git");
  assert.deepEqual(gh.value.kind === "git" ? gh.value.repo : null, {
    provider: "github",
    url: "https://github.com/IdraDev/creator_wars.git",
    repo: "IdraDev/creator_wars",
    branch: "master",
    triggerType: "push",
    watchPaths: [],
    submodules: false,
  });

  // A self-hosted host is taken from the address the panel handed over, never rebuilt from parts onto gitea.com.
  const self = cloneTarget({
    applicationId: "a2",
    sourceType: "gitea",
    buildType: "nixpacks",
    customGitUrl: "https://git.acme.com/team/app.git",
    customGitBranch: "main",
  } as Parameters<typeof cloneTarget>[0]);
  assert.equal(self?.provider, "gitea");
  assert.equal(self?.url, "https://git.acme.com/team/app.git");
  assert.equal(self?.repo, "team/app");
});

test("a stack says which registries it pulls from", () => {
  const compose = `services:\n  api:\n    image: ghcr.io/acme/private:latest\n  web:\n    image: nginx:alpine\n  worker:\n    image: ghcr.io/acme/other:1\n`;
  const notes = composeRegistryNotes(compose);
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /pulls from ghcr\.io\./);
  // Docker Hub needs no login to say so, and a stack with only those says nothing.
  assert.deepEqual(
    composeRegistryNotes(`services:\n  web:\n    image: nginx:alpine\n`),
    [],
  );
  assert.deepEqual(composeRegistryNotes("not: yaml: at all: ["), []);
});
