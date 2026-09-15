import { builder } from "../../builder";
import { ServerRef } from "./server-ref";
import {
  updateServerAgent,
  updateServerAddress,
} from "@/lib/data/servers/agent-maintenance";
import { addServer, reissueBootstrap } from "@/lib/data/servers/enrollment";
import {
  removeServer,
  uninstallServerAgent,
  type ServerRemoval,
  type ServerUninstall,
} from "@/lib/data/servers/removal";
import type { Server } from "@/lib/types/server";

interface AddServerPayload {
  server: Server;
  installCommand: string;
}

const AddServerPayloadRef = builder
  .objectRef<AddServerPayload>("AddServerPayload")
  .implement({
    description:
      "A newly registered server + its one-time agent install command.",
    fields: (t) => ({
      server: t.field({ type: ServerRef, resolve: (p) => p.server }),
      installCommand: t.exposeString("installCommand", {
        description:
          "Paste-on-the-server command to provision the agent. Shown once; embeds a single-use token.",
      }),
    }),
  });

const ServerRemovalRef = builder
  .objectRef<ServerRemoval>("ServerRemoval")
  .implement({
    description:
      "The result of removing a server. Removal revokes the agent's trust and forgets the row - it does NOT uninstall anything on the host, so the uninstall command is always returned.",
    fields: (t) => ({
      uninstallCommand: t.exposeString("uninstallCommand", {
        description:
          "Paste-on-the-server command that removes the agent, Traefik and the Deplo network from the host. Deplo cannot do this remotely: revoking trust is precisely what ends its right to command that agent.",
      }),
      warning: t.exposeString("warning", {
        nullable: true,
        description:
          "A non-blocking hazard the operator must know about (e.g. an App was mid-move off this host, so its data volumes are now stranded there), or null.",
      }),
    }),
  });

const ServerUninstallRef = builder
  .objectRef<ServerUninstall>("ServerUninstall")
  .implement({
    description:
      "The result of uninstalling the agent from a MIGRATION SOURCE. Unlike ServerRemoval this one DOES touch the host - it is the only case where Deplo installed the agent on a machine that is not part of the fleet, so taking it back off is Deplo's job and not the operator's.",
    fields: (t) => ({
      removed: t.exposeBoolean("removed", {
        description:
          "True when the host is clean AND the server row is gone. False leaves both in place - the agent is still installed there, and pretending otherwise would strand a running agent nobody can see.",
      }),
      uninstallCommand: t.exposeString("uninstallCommand", {
        description:
          "The host-side command, returned in both cases: on success so the operator can verify, on failure because it is then the only way through.",
      }),
      error: t.exposeString("error", {
        nullable: true,
        description:
          "Why the uninstall did not happen, or null. Surface it verbatim.",
      }),
      warning: t.exposeString("warning", {
        nullable: true,
        description:
          "A non-blocking hazard, same meaning as on ServerRemoval, or null.",
      }),
    }),
  });

const AddServerInputType = builder.inputType("AddServerInput", {
  description:
    "Register a remote server. Provisioned by a call-home bootstrap (no SSH-in): you run the returned install command on the box.",
  fields: (t) => ({
    name: t.string({ required: true }),
    host: t.string({ required: true }),
    allTeams: t.boolean({ required: false }),
    teamIds: t.stringList({ required: false }),
    storageOnly: t.boolean({ required: false }),
    buildOnly: t.boolean({ required: false }),
    importOnly: t.boolean({ required: false }),
  }),
});

builder.mutationFields((t) => ({
  addServer: t.field({
    type: AddServerPayloadRef,
    authScopes: { instanceAdmin: true },
    args: { input: t.arg({ type: AddServerInputType, required: true }) },
    resolve: (_r, { input }) =>
      addServer({
        name: input.name,
        host: input.host,
        allTeams: input.allTeams ?? undefined,
        teamIds: input.teamIds ?? undefined,
        storageOnly: input.storageOnly ?? undefined,
        buildOnly: input.buildOnly ?? undefined,
        importOnly: input.importOnly ?? undefined,
      }),
  }),
  uninstallServerAgent: t.field({
    type: ServerUninstallRef,
    authScopes: { instanceAdmin: true },
    description:
      'Take Deplo off a MIGRATION SOURCE: uninstall the agent from the host (systemd unit, binary, state dir - never Docker), then forget the server. Only a server whose role is "import" - an ordinary server is removed with removeServer, which is trust revocation and leaves the host alone. `removed: false` means the host still has the agent on it and the server row was KEPT; `uninstallCommand` is returned either way, because an unreachable or de-trusted host will always need the host-side path. A registration whose install command was never run has nothing to uninstall and is simply forgotten.',
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => uninstallServerAgent(id),
  }),
  reissueServerBootstrap: t.field({
    type: AddServerPayloadRef,
    authScopes: { instanceAdmin: true },
    description:
      "Mint a fresh install command for a server still provisioning (the original token expired or was lost).",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => reissueBootstrap(id),
  }),
  updateServerAddress: t.string({
    nullable: true,
    authScopes: { instanceAdmin: true },
    description:
      "Rewrite where Deplo dials this server's agent - the migration verb for a host whose IP changed. Unless `force`, the agent must answer at the new address (same pinned certificate) before anything is saved. Returns a warning to surface, or null.",
    args: {
      id: t.arg.string({ required: true }),
      address: t.arg.string({ required: true }),
      agentPort: t.arg.int({ required: false }),
      force: t.arg.boolean({ required: false }),
      keepHost: t.arg.boolean({
        required: false,
        description:
          "Write only where Deplo dials, keeping the address the server was registered at. The migration wizard's flag: a panel behind a proxy hands out the proxy's address, and the import still has to recognise the machine by the one it came from.",
      }),
    },
    resolve: async (_r, args) =>
      (
        await updateServerAddress({
          id: args.id,
          address: args.address,
          agentPort: args.agentPort ?? null,
          force: args.force ?? false,
          keepHost: args.keepHost ?? false,
        })
      ).warning,
  }),
  removeServer: t.field({
    type: ServerRemovalRef,
    authScopes: { instanceAdmin: true },
    description:
      "Remove a server: revoke its agent's trust and forget the row. This does NOT uninstall anything on the host (the agent, Traefik and the Deplo network keep running there), so the returned payload always carries the host-side uninstall command. Blocked while any App or database still lives on the server.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => removeServer(id),
  }),
  updateServerAgent: t.field({
    type: "String",
    authScopes: { instanceAdmin: true },
    description:
      "Update this server's agent binary in place to the latest released version WITHOUT reissuing its certificates - the agent self-updates over its existing pinned-mTLS channel and re-execs keeping the same on-disk trust materials, so the server stays online with the same identity. Returns the version the agent is now running. Errors clearly when the server is unreachable/unprovisioned, or, until the agent ships the self-update RPC, when its agent is too old to update itself remotely (re-run the installer to upgrade it for now).",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      const { version } = await updateServerAgent(id);
      return version;
    },
  }),
}));
