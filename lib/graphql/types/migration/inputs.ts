import { builder } from "../../builder";
import { MigrationPlatformEnum } from "./enums";

export const RunTargetInput = builder.inputType("MigrationRunTargetInput", {
  fields: (t) => ({
    projectId: t.string({ required: true }),
    projectName: t.string({
      required: true,
      description:
        "Shown while the run works through it, so the runner needs no second read of the API for a name.",
    }),
    serviceId: t.string({ required: true }),
    serverId: t.string({ required: false }),
    buildServerId: t.string({ required: false }),
    exposedPort: t.int({
      required: false,
      description:
        "A database's host port. THREE values, and the difference matters: omitted keeps the source's own, `null` publishes nothing, a number publishes there.",
    }),
  }),
});

export const QueuedTeamInputRef = builder.inputType(
  "MigrationQueuedTeamInput",
  {
    fields: (t) => ({
      apiKey: t.string({
        required: true,
        description: "That team's own token - a key reads exactly one team.",
      }),
      orgName: t.string({ required: false }),
      teamId: t.string({
        required: false,
        description:
          "The Deplo team it lands in. Omit to have one created for it now, named by `newTeamName`.",
      }),
      newTeamName: t.string({ required: false }),
      newTeamImage: t.string({ required: false }),
      targets: t.field({ type: [RunTargetInput], required: true }),
      servers: t.field({ type: [ServerChoiceInput], required: false }),
    }),
  },
);

export const ServerChoiceInput = builder.inputType(
  "MigrationServerChoiceInput",
  {
    description:
      "Map one of the panel's servers onto one of ours. `from` is that server's id, or the empty string for the panel's own host.",
    fields: (t) => ({
      from: t.string({ required: true }),
      to: t.string({ required: true }),
    }),
  },
);

export const PlacementInput = builder.inputType("MigrationPlacementInput", {
  description:
    "Where one service lands. `serviceId` is the `sourceId` a scan reports. Omit `buildServerId` (or send null) for Automatic - Deplo uses a build server if the fleet has one, and compiles where the app runs otherwise.",
  fields: (t) => ({
    serviceId: t.string({ required: true }),
    serverId: t.string({ required: true }),
    buildServerId: t.string({ required: false }),
    exposedPort: t.int({
      required: false,
      description:
        "A database's host port. Omit the field to keep the port it had over there (what the import has always done); send null to publish nothing; send a number to publish there instead - which is how a review resolves a port something else already holds on the target server. Ignored for anything that is not a database.",
    }),
  }),
});

export const ConnectInputRef = builder.inputType("MigrationSourceInput", {
  fields: (t) => ({
    url: t.string({
      required: true,
      description:
        "The panel's address. Deplo appends the API path itself, so paste the address you open in a browser.",
    }),
    apiKey: t.string({
      required: true,
      description:
        "The panel's API key or token. Dokploy: Settings -> Profile -> API/CLI. Coolify: Keys & Tokens -> API tokens, with `root` ticked - a narrower token cannot read values or stop a service, and Deplo refuses it at Connect. Use an owner's or admin's either way: a plain member's is refused. Never stored.",
    }),
    kind: t.field({
      type: MigrationPlatformEnum,
      required: false,
      description:
        "Read the panel as this product. Omit it and Deplo works out which it is from the address and the token.",
    }),
  }),
});
