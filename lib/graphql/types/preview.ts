import { builder } from "../builder";
import {
  approvePreview,
  deletePreviewEnvVar,
  deployPullRequest,
  destroyPreview,
  listAppPreviews,
  listOpenPullRequestsForApp,
  listPreviewEnvVars,
  redeployPreview,
  setAppPreviewSettings,
  setPreviewEnvVar,
  type AppPreviewDTO,
  type AppPreviewsView,
  type PreviewEnvVarDTO,
} from "@/lib/data/previews";
import type { GithubPullRequestSummary } from "@/lib/github/app";

/* ------------------------------------------------------------------ */
/* Object types - pull request previews (ADR-0014)                     */
/* ------------------------------------------------------------------ */

export const AppPreviewRef = builder
  .objectRef<AppPreviewDTO>("AppPreview")
  .implement({
    description:
      "An ephemeral deploy of one App for one open pull request, running as its " +
      "own stack `deplo-<slug>__pr-<n>` with its own URL. Not an App and not an " +
      "Environment.",
    fields: (t) => ({
      id: t.exposeID("id"),
      appId: t.exposeID("appId"),
      prNumber: t.exposeInt("prNumber"),
      title: t.exposeString("title"),
      author: t.exposeString("author"),
      pullRequestUrl: t.exposeString("pullRequestUrl"),
      headBranch: t.exposeString("headBranch"),
      baseBranch: t.exposeString("baseBranch"),
      headRepo: t.exposeString("headRepo"),
      isFork: t.exposeBoolean("isFork", {
        description:
          "The head lives in a repository the operator does not control, so its " +
          "code is untrusted and it never receives secret-typed variables.",
      }),
      approved: t.exposeBoolean("approved", {
        description:
          "A fork's pull request only builds once a member with `deploy` approves it.",
      }),
      approvedSha: t.exposeString("approvedSha", { nullable: true }),
      status: t.exposeString("status", {
        description: "blocked | queued | building | active | error | idle.",
      }),
      url: t.exposeString("url"),
      host: t.exposeString("host"),
      closed: t.exposeBoolean("closed"),
      latestDeploymentId: t.exposeID("latestDeploymentId", { nullable: true }),
      createdAt: t.exposeString("createdAt"),
      updatedAt: t.exposeString("updatedAt"),
    }),
  });

export const AppPreviewsViewRef = builder
  .objectRef<AppPreviewsView>("AppPreviewsView")
  .implement({
    description:
      "Everything the Pull requests page renders in one read: whether previews " +
      "can work at all, the branch they watch, the app's settings, and the previews.",
    fields: (t) => ({
      appId: t.exposeID("appId"),
      unavailable: t.exposeString("unavailable", {
        nullable: true,
        description:
          "null ⇒ previews work. Otherwise the ONE reason they cannot: " +
          "not-github | no-installation | app-needs-update | disabled.",
      }),
      branch: t.exposeString("branch", {
        description: "Pull requests must target this branch to get a preview.",
      }),
      githubSettingsUrl: t.exposeString("githubSettingsUrl", {
        nullable: true,
      }),
      enabled: t.exposeBoolean("enabled"),
      baseDomain: t.exposeString("baseDomain", { nullable: true }),
      maxActive: t.exposeInt("maxActive"),
      ttlDays: t.exposeInt("ttlDays"),
      forkPolicy: t.exposeString("forkPolicy"),
      serverId: t.exposeString("serverId", { nullable: true }),
      https: t.exposeBoolean("https"),
      autoDeploy: t.exposeBoolean("autoDeploy"),
      port: t.exposeInt("port", { nullable: true }),
      buildDrafts: t.exposeBoolean("buildDrafts"),
      comment: t.exposeBoolean("comment"),
      requiredLabels: t.exposeStringList("requiredLabels"),
      previews: t.field({
        type: [AppPreviewRef],
        resolve: (v) => v.previews,
      }),
    }),
  });

export const GithubPullRequestRef = builder
  .objectRef<GithubPullRequestSummary>("GithubPullRequest")
  .implement({
    description: "An open pull request on the app's repository.",
    fields: (t) => ({
      number: t.exposeInt("number"),
      title: t.exposeString("title"),
      headRef: t.exposeString("headRef"),
      baseRef: t.exposeString("baseRef"),
      fromFork: t.exposeBoolean("fromFork"),
      draft: t.exposeBoolean("draft"),
      authorLogin: t.exposeString("authorLogin"),
      htmlUrl: t.exposeString("htmlUrl"),
      updatedAt: t.exposeString("updatedAt"),
    }),
  });

export const PreviewEnvVarRef = builder
  .objectRef<PreviewEnvVarDTO>("PreviewEnvVar")
  .implement({
    description:
      "A preview-only variable override. Write-only, like every stored secret: " +
      "the value is never projected and there is no reveal path.",
    fields: (t) => ({
      key: t.exposeString("key"),
      type: t.exposeString("type"),
      updatedAt: t.exposeString("updatedAt"),
    }),
  });

/* ------------------------------------------------------------------ */
/* Query                                                               */
/* ------------------------------------------------------------------ */

const deployScope = { capability: "manage_previews" } as const;
const envScope = { capability: "manage_env" } as const;

builder.queryFields((t) => ({
  appPreviews: t.field({
    type: AppPreviewsViewRef,
    authScopes: deployScope,
    description:
      "Pull request previews for an app, plus why they may not work.",
    args: { appId: t.arg.id({ required: true }) },
    resolve: (_r, { appId }) => listAppPreviews(String(appId)),
  }),
  openPullRequests: t.field({
    type: [GithubPullRequestRef],
    authScopes: deployScope,
    description:
      "Open pull requests on the app's repository, for the deploy picker. " +
      "Needs only `pull_requests: read`, which every Deplo GitHub App has.",
    args: { appId: t.arg.id({ required: true }) },
    resolve: (_r, { appId }) => listOpenPullRequestsForApp(String(appId)),
  }),
  previewEnvVars: t.field({
    type: [PreviewEnvVarRef],
    authScopes: envScope,
    description: "The app's preview-only variable overrides (advanced).",
    args: { appId: t.arg.id({ required: true }) },
    resolve: (_r, { appId }) => listPreviewEnvVars(String(appId)),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

const PreviewSettingsInput = builder.inputType("AppPreviewSettingsInput", {
  fields: (t) => ({
    enabled: t.boolean({ required: false }),
    baseDomain: t.string({
      required: false,
      description:
        "e.g. `preview.example.com`, with a wildcard DNS record pointing here. " +
        "Empty clears it back to the zero-configuration nip.io default.",
    }),
    maxActive: t.int({ required: false }),
    ttlDays: t.int({ required: false }),
    forkPolicy: t.string({
      required: false,
      description: "deny | approve | allow.",
    }),
    serverId: t.string({
      required: false,
      description: "Where previews run. Empty ⇒ the app's own server.",
    }),
    https: t.boolean({
      required: false,
      description: "Serve previews over HTTPS. Needs a preview domain.",
    }),
    autoDeploy: t.boolean({
      required: false,
      description: "Rebuild a preview when its pull request gets a new commit.",
    }),
    port: t.int({
      required: false,
      description: "Container port. Empty ⇒ the app's build port.",
    }),
    buildDrafts: t.boolean({
      required: false,
      description: "Build a pull request that is still a draft.",
    }),
    comment: t.boolean({
      required: false,
      description: "Post the preview URL as a comment on the pull request.",
    }),
    requiredLabels: t.string({
      required: false,
      description:
        "Newline-separated labels a pull request must carry. Empty ⇒ no filter.",
    }),
  }),
});

builder.mutationFields((t) => ({
  setAppPreviewSettings: t.field({
    type: "Boolean",
    authScopes: deployScope,
    description: "Turn pull request previews on or off, and set their options.",
    args: {
      appId: t.arg.id({ required: true }),
      input: t.arg({ type: PreviewSettingsInput, required: true }),
    },
    resolve: async (_r, { appId, input }) => {
      await setAppPreviewSettings(String(appId), {
        enabled: input.enabled ?? undefined,
        baseDomain: input.baseDomain ?? undefined,
        maxActive: input.maxActive ?? undefined,
        ttlDays: input.ttlDays ?? undefined,
        forkPolicy: input.forkPolicy ?? undefined,
        serverId: input.serverId ?? undefined,
        https: input.https ?? undefined,
        autoDeploy: input.autoDeploy ?? undefined,
        port: input.port ?? undefined,
        buildDrafts: input.buildDrafts ?? undefined,
        comment: input.comment ?? undefined,
        requiredLabels: input.requiredLabels ?? undefined,
      });
      return true;
    },
  }),
  deployPullRequest: t.field({
    type: AppPreviewRef,
    authScopes: deployScope,
    description:
      "Build a preview for a specific open pull request. Also approves it when " +
      "it comes from a fork - clicking this IS the approval.",
    args: {
      appId: t.arg.id({ required: true }),
      prNumber: t.arg.int({ required: true }),
    },
    resolve: (_r, { appId, prNumber }) =>
      deployPullRequest(String(appId), prNumber),
  }),
  redeployPreview: t.field({
    type: AppPreviewRef,
    authScopes: deployScope,
    description: "Rebuild an existing preview at its current head.",
    args: { id: t.arg.id({ required: true }) },
    resolve: (_r, { id }) => redeployPreview(String(id)),
  }),
  approvePreview: t.field({
    type: AppPreviewRef,
    authScopes: deployScope,
    description:
      "Unblock a fork's pull request and build it. Approval is per pull request, " +
      "so later commits on it build automatically.",
    args: { id: t.arg.id({ required: true }) },
    resolve: (_r, { id }) => approvePreview(String(id)),
  }),
  destroyPreview: t.field({
    type: "Boolean",
    authScopes: deployScope,
    description:
      "Stop a preview and remove its containers and volumes. The next commit on " +
      "the pull request builds it again.",
    args: { id: t.arg.id({ required: true }) },
    resolve: (_r, { id }) => destroyPreview(String(id)),
  }),
  setPreviewEnvVar: t.field({
    type: "Boolean",
    authScopes: envScope,
    description:
      "Set a preview-only override for one variable (advanced). It outranks the " +
      "app's own value and any shared variable, in previews only.",
    args: {
      appId: t.arg.id({ required: true }),
      key: t.arg.string({ required: true }),
      value: t.arg.string({ required: true }),
      secret: t.arg.boolean({ required: false }),
    },
    resolve: async (_r, { appId, key, value, secret }) => {
      await setPreviewEnvVar(
        String(appId),
        key,
        value,
        secret ? "secret" : "plain",
      );
      return true;
    },
  }),
  deletePreviewEnvVar: t.field({
    type: "Boolean",
    authScopes: envScope,
    description: "Remove a preview-only override.",
    args: {
      appId: t.arg.id({ required: true }),
      key: t.arg.string({ required: true }),
    },
    resolve: async (_r, { appId, key }) => {
      await deletePreviewEnvVar(String(appId), key);
      return true;
    },
  }),
}));
