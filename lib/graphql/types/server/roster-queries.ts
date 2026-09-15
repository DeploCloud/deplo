import { builder } from "../../builder";
import { ServerRef } from "./server-ref";
import { agentUninstallCommand } from "@/lib/data/servers/removal";
import {
  listServers,
  getServer,
  getPrimaryServer,
  listBuildServerChoices,
} from "@/lib/data/servers/roster";

const BuildServerChoiceRef = builder
  .objectRef<{
    id: string;
    name: string;
    hostArch: string;
    buildOnly: boolean;
    buildFallback: boolean;
    isDeploHost: boolean;
  }>("BuildServerChoice")
  .implement({
    description:
      "One entry in the 'Build on' picker: a host this team may compile on.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      hostArch: t.exposeString("hostArch", {
        description:
          'Its CPU architecture ("amd64" | "arm64"), or "" when the agent is too old to report one. An image only runs on a host of the same architecture, so a choice whose arch differs from the app\'s server must be disabled rather than offered.',
      }),
      buildOnly: t.exposeBoolean("buildOnly", {
        description:
          "True for a host dedicated to building (it runs no apps). False for an ordinary server that would build for this app in addition to hosting its own.",
      }),
      buildFallback: t.exposeBoolean("buildFallback", {
        description:
          "Whether this host takes over when an app's own build server cannot be reached. True on the Deplo host by default; setServerBuildFallback is what changes it.",
      }),
      isDeploHost: t.exposeBoolean("isDeploHost", {
        description:
          "Whether this is the host running Deplo itself, as opposed to a remote that only runs the deploy agent.",
      }),
    }),
  });

builder.queryFields((t) => ({
  servers: t.field({
    type: [ServerRef],
    authScopes: { loggedIn: true },
    description: "All servers, by creation order.",
    resolve: () => listServers(),
  }),
  server: t.field({
    type: ServerRef,
    nullable: true,
    authScopes: { loggedIn: true },
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => getServer(id),
  }),
  agentUninstallCommand: t.string({
    authScopes: { loggedIn: true },
    description:
      "The paste-on-the-host command that removes Deplo's agent from a machine. Instance-wide, identical for every host, and carrying no secret - the installer it points at is served unauthenticated by design. Shown next to a migration source Deplo could not reach, because an unreachable host's agent can only be taken off from the host.",
    resolve: () => agentUninstallCommand(),
  }),
  primaryServer: t.field({
    type: ServerRef,
    nullable: true,
    authScopes: { loggedIn: true },
    description:
      "The first server available, or null when none has been added/provisioned yet.",
    resolve: () => getPrimaryServer(),
  }),
  buildServerChoices: t.field({
    type: [BuildServerChoiceRef],
    authScopes: { loggedIn: true },
    description:
      "The hosts this team can compile on, for an app's 'Build on' setting. Wider than the deploy-target list on purpose: a build-only server is here BECAUSE it cannot deploy, and an ordinary server is here too (one big machine can build for several small ones without giving up its own apps). Two roles are excluded: storage-only (no Docker, no build) and a migration source (it has Docker, but it is another platform's machine and a build would ship the app's source and decrypted env there). `hostArch` is included so the caller can disable the servers whose architecture cannot produce a runnable image for the target.",
    resolve: () => listBuildServerChoices(),
  }),
}));
