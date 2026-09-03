import { builder } from "../builder";
import { MIGRATION_PLATFORMS } from "@/lib/migration/source";
import {
  cancelTakeover,
  requestTakeover,
  takeoverPreflight,
  takeoverStatus,
  TAKEOVER_STATES,
  type TakeoverPreflight,
  type TakeoverStatus,
} from "@/lib/data/takeover";

/**
 * The takeover - Deplo installed onto a machine another panel already owns. The
 * host-side work is the installer's; these are the three things a person decides.
 */

const TakeoverStateEnum = builder.enumType("TakeoverState", {
  description:
    "pending = the migration is not finished. ready = the operator asked for the machine and the installer is moving the ports. done = the ports are Deplo's. removing / removed = the old platform is coming off the disk. cancelled = the operator backed out and Deplo is uninstalling itself.",
  values: TAKEOVER_STATES,
});

const TakeoverPlatformEnum = builder.enumType("TakeoverPlatform", {
  description: "The panel this install is replacing.",
  values: MIGRATION_PLATFORMS,
});

const TakeoverRef = builder.objectRef<TakeoverStatus>("Takeover").implement({
  description:
    "The takeover this instance is in the middle of. Null on an ordinary install.",
  fields: (t) => ({
    platform: t.field({
      type: TakeoverPlatformEnum,
      resolve: (s) => s.platform,
    }),
    state: t.field({ type: TakeoverStateEnum, resolve: (s) => s.state }),
    runId: t.exposeString("runId", { nullable: true }),
    seenExternalRequest: t.exposeBoolean("seenExternalRequest", {
      description:
        "Whether anything but the installer has ever reached this panel. False means its port is probably closed, not that nobody has looked.",
    }),
  }),
});

const CancelResultRef = builder
  .objectRef<{ restarted: number; left: string[] }>("TakeoverCancelResult")
  .implement({
    fields: (t) => ({
      restarted: t.exposeInt("restarted", {
        description:
          "How many services were started again on the platform being kept.",
      }),
      left: t.exposeStringList("left", {
        description: "The ones that would not start, with the reason.",
      }),
    }),
  });

const PreflightRef = builder
  .objectRef<TakeoverPreflight>("TakeoverPreflight")
  .implement({
    description:
      "What a takeover of this machine is walking into. Both halves are things that otherwise only show up mid-copy.",
    fields: (t) => ({
      diskFreeBytes: t.exposeFloat("diskFreeBytes"),
      diskTotalBytes: t.exposeFloat("diskTotalBytes"),
      diskTight: t.exposeBoolean("diskTight", {
        description:
          "The copy writes a second copy of every volume it moves, and this machine has little room for one. A warning with the real numbers, never a refusal.",
      }),
      agentReady: t.exposeBoolean("agentReady", {
        description:
          "Whether the agent on this machine answers a live probe. Without it no volume can be read at all.",
      }),
      agentMessage: t.exposeString("agentMessage"),
    }),
  });

builder.queryFields((t) => ({
  takeoverPreflight: t.field({
    type: PreflightRef,
    nullable: true,
    authScopes: { instanceAdmin: true },
    description:
      "Null when this panel's own machine is not a server Deplo knows about, which is the one case where none of it can be measured.",
    resolve: () => takeoverPreflight(),
  }),
  takeover: t.field({
    type: TakeoverRef,
    nullable: true,
    authScopes: { instanceAdmin: true },
    description:
      "The takeover in progress, or null. The screen that replaces the dashboard reads its own state server-side; this is the poll behind the buttons, and only an instance admin has any.",
    resolve: () => takeoverStatus(),
  }),
}));

builder.mutationFields((t) => ({
  requestTakeover: t.field({
    type: TakeoverRef,
    authScopes: { instanceAdmin: true },
    description:
      "Hand the machine to Deplo. The installer is waiting for this: it stops the other platform, inherits its certificates, moves Traefik onto 80/443 and the dashboard onto 3000, and then takes the other platform off the disk for good.",
    args: {
      runId: t.arg.string({ required: true }),
      noOtherTeams: t.arg.boolean({
        required: false,
        description:
          "The operator says this panel has no team left to bring over. Required only when the migration itself says one is still owed, because a token reads a single team and the cutover stops the panel for good.",
      }),
    },
    resolve: (_r, { runId, noOtherTeams }) =>
      requestTakeover(runId, { noOtherTeams: noOtherTeams ?? false }),
  }),
  cancelTakeover: t.field({
    type: CancelResultRef,
    authScopes: { instanceAdmin: true },
    description:
      "Back out. Starts again everything the migration stopped on the other platform, undoes what it created here, and tells the installer to uninstall Deplo. The panel's API token is wiped when a run ends, so one has to be handed over again.",
    args: { apiKey: t.arg.string({ required: false }) },
    resolve: (_r, { apiKey }) => cancelTakeover(apiKey ?? undefined),
  }),
}));
