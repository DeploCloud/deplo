import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_GIT_DEPLOY_OPTIONS } from "@/components/apps/git-deploy-options";
import { withMethodChoice } from "@/lib/apps/build-method";
import { buildConfigFor } from "@/lib/frameworks";

import { buildCreateAppInput } from "./create-app";

type Args = Parameters<typeof buildCreateAppInput>[0];

const repoApp = (over: Partial<Args> = {}): Args => ({
  name: "web",
  serverId: "srv_1",
  buildServerId: null,
  source: "github",
  isTemplate: false,
  useCompose: false,
  templateCompose: false,
  compose: "",
  composeDiags: [],
  composeUpArgs: "",
  composeArgsProblem: null,
  ghSelection: {
    installationId: "inst_1",
    fullName: "acme/web",
    branch: "main",
  },
  gitValue: {
    provider: "git",
    url: "",
    repo: "",
    branch: "main",
    connectionId: null,
  },
  dockerImage: "",
  gitOptions: DEFAULT_GIT_DEPLOY_OPTIONS,
  buildsImage: true,
  build: buildConfigFor({ methodAuto: true }),
  envRows: [],
  sharedIds: [],
  usesGit: true,
  autoDeploy: true,
  shouldDeploy: true,
  primaryService: null,
  routeCandidates: [],
  extraRouted: [],
  ...over,
});

const methodSent = (args: Args) =>
  (buildCreateAppInput(args)?.build as { buildMethod: string }).buildMethod;

test("a new app built from code asks Deplo to detect its build method", () => {
  assert.equal(methodSent(repoApp()), "auto");
  assert.equal(
    methodSent(repoApp({ source: "upload", usesGit: false })),
    "auto",
  );
});

test("a method picked under Advanced is sent as picked, and picking auto again undoes it", () => {
  const picked = withMethodChoice(
    buildConfigFor({ methodAuto: true }),
    "dockerfile",
  );
  assert.equal(methodSent(repoApp({ build: picked })), "dockerfile");
  assert.equal(
    methodSent(repoApp({ build: withMethodChoice(picked, "auto") })),
    "auto",
  );
});

test("an image or a compose stack still sends what it did before", () => {
  const image = repoApp({
    source: "docker-image",
    dockerImage: "nginx:1.27",
    buildsImage: false,
    usesGit: false,
  });
  assert.equal(methodSent(image), "dockerfile");
  const stack = repoApp({
    source: "compose",
    useCompose: true,
    compose: "services:\n  web:\n    image: nginx\n",
    buildsImage: false,
    usesGit: false,
  });
  assert.equal(methodSent(stack), "dockerfile");
});
