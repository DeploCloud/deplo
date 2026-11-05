import { builder } from "../builder";
import {
  cloneRepository,
  githubSignInUrl,
  listCloneDestinations,
  type CloneDestination,
  type CloneDestinations,
  type ClonedRepository,
} from "@/lib/data/clone-repository";

// https://deplo.build/docs/guides/deploy/deploy-button
const CloneDestinationRef = builder
  .objectRef<CloneDestination>("CloneDestination")
  .implement({
    description:
      "An account or group on one of the team's git connections where Deplo can create a repository.",
    fields: (t) => ({
      key: t.exposeString("key"),
      provider: t.exposeString("provider", {
        description: "github | gitlab | bitbucket | gitea.",
      }),
      providerLabel: t.exposeString("providerLabel"),
      installationId: t.exposeString("installationId", { nullable: true }),
      connectionId: t.exposeString("connectionId", { nullable: true }),
      ownerId: t.exposeString("ownerId", {
        description: "Pass it back as cloneRepository's owner.",
      }),
      login: t.exposeString("login"),
      avatarUrl: t.exposeString("avatarUrl"),
      personal: t.exposeBoolean("personal"),
      needs: t.exposeString("needs", {
        nullable: true,
        description:
          "github-sign-in | github-permissions, or null when a repository can be created here now.",
      }),
      settingsUrl: t.exposeString("settingsUrl", {
        nullable: true,
        description: "Where to grant the missing GitHub App permissions.",
      }),
    }),
  });

const CloneDestinationsRef = builder
  .objectRef<CloneDestinations>("CloneDestinations")
  .implement({
    fields: (t) => ({
      destinations: t.field({
        type: [CloneDestinationRef],
        resolve: (p) => p.destinations,
      }),
      unreachable: t.exposeStringList("unreachable", {
        description: "Labels of git connections that did not answer.",
      }),
    }),
  });

const ClonedRepositoryRef = builder
  .objectRef<ClonedRepository>("ClonedRepository")
  .implement({
    description:
      "The new repository: create the app from it as from any other repository.",
    fields: (t) => ({
      provider: t.exposeString("provider"),
      fullName: t.exposeString("fullName"),
      url: t.exposeString("url"),
      branch: t.exposeString("branch"),
      installationId: t.exposeString("installationId", { nullable: true }),
      connectionId: t.exposeString("connectionId", { nullable: true }),
      composeFile: t.exposeString("composeFile", { nullable: true }),
    }),
  });

const CloneRepositoryInputRef = builder.inputType("CloneRepositoryInput", {
  fields: (t) => ({
    repo: t.string({
      required: false,
      description: "A public GitHub or GitLab repository link.",
    }),
    compose: t.string({
      required: false,
      description:
        "A link to a compose file in that repository. Alone, it names the repository too.",
    }),
    installationId: t.string({
      required: false,
      description: "Create it on this GitHub account.",
    }),
    connectionId: t.string({
      required: false,
      description: "Create it through this git connection.",
    }),
    owner: t.string({
      required: true,
      description: "The CloneDestination's ownerId.",
    }),
    name: t.string({ required: true }),
    private: t.boolean({ required: true }),
  }),
});

builder.queryFields((t) => ({
  cloneDestinations: t.field({
    type: CloneDestinationsRef,
    authScopes: { capability: "create_apps" },
    description:
      "Where Deplo can create a repository for a Deploy button's project.",
    resolve: () => listCloneDestinations(),
  }),
  githubSignInUrl: t.field({
    type: "String",
    authScopes: { capability: "create_apps" },
    description:
      "Where to send a person to sign in to GitHub, so Deplo can create a repository in their personal account.",
    args: {
      installationId: t.arg.string({ required: true }),
      returnTo: t.arg.string({ required: false }),
    },
    resolve: (_r, { installationId, returnTo }) =>
      githubSignInUrl(installationId, returnTo ?? null),
  }),
}));

builder.mutationFields((t) => ({
  cloneRepository: t.field({
    type: ClonedRepositoryRef,
    authScopes: { capability: "create_apps" },
    description:
      "Copy a public repository into a new repository on one of the team's git accounts. It never deletes or changes an existing repository.",
    args: { input: t.arg({ type: CloneRepositoryInputRef, required: true }) },
    resolve: (_r, { input }) =>
      cloneRepository({
        repo: input.repo,
        compose: input.compose,
        installationId: input.installationId,
        connectionId: input.connectionId,
        owner: input.owner,
        name: input.name,
        private: input.private,
      }),
  }),
}));
