import { builder } from "../../builder";
import { MigrationPlanStatusEnum, MigrationPlatformEnum } from "./enums";
import {
  type MigrationPlan,
  type PlanEnvironment,
  type PlanProject,
  type PlanService,
  type SourceIdentity,
} from "@/lib/data/migration-import/scan";
import { type PlanServer } from "@/lib/data/migration-import/source-machines";
import type { PlanMember } from "@/lib/data/migration-import/source-people";

export const PlanServiceRef = builder
  .objectRef<PlanService>("MigrationPlanService")
  .implement({
    description:
      "One service on the panel (an application, a compose stack, or a database) as it would land here.",
    fields: (t) => ({
      sourceId: t.exposeString("sourceId"),
      kind: t.exposeString("kind", {
        description:
          "What it is over there: application, compose, or one of the panel's database engines.",
      }),
      name: t.exposeString("name"),
      targetKind: t.exposeString("targetKind", {
        nullable: true,
        description: "app or database, or null when Deplo has no equivalent.",
      }),
      status: t.field({
        type: MigrationPlanStatusEnum,
        resolve: (s) => s.status,
      }),
      sourceServerId: t.exposeString("sourceServerId", {
        description:
          "The panel's server it runs on. Empty string means the panel's own host, which has no server row over there.",
      }),
      buildsFromSource: t.exposeBoolean("buildsFromSource", {
        description:
          "Whether Deplo would ever compile this. False for a compose stack, a prebuilt image and a database - all of them deploy as they are, so a build server would have nothing to do for them.",
      }),
      engine: t.exposeString("engine", {
        nullable: true,
        description:
          "Deplo's own engine id for a database (`mongo` over there is `mongodb` here), so a client can show the engine's brand mark. Null for anything that is not a database Deplo has.",
      }),
      exposedPort: t.exposeInt("exposedPort", {
        nullable: true,
        description:
          "The host port this database publishes over there, so a review can say what will be published and offer another port when that one is taken here. Describes the SOURCE: it is reported whether or not the caller holds the publish-ports grant, and null only for something that is not a database or publishes nothing.",
      }),
      domains: t.exposeStringList("domains", {
        description:
          "The hostnames that would come across. The panel's generated throwaway hosts (traefik.me, sslip.io, nip.io) are already dropped - Deplo mints its own.",
      }),
      logo: t.exposeString("logo", {
        nullable: true,
        description:
          "The icon this service would arrive with, as an inline data-URI, or null when it has none. Already validated against what Deplo will store, so a client can render it as-is.",
      }),
      notes: t.exposeStringList("notes", {
        description:
          "What will not come across, or will need a look afterwards.",
      }),
    }),
  });

export const PlanEnvironmentRef = builder
  .objectRef<PlanEnvironment>("MigrationPlanEnvironment")
  .implement({
    fields: (t) => ({
      sourceId: t.exposeString("sourceId"),
      name: t.exposeString("name"),
      exists: t.exposeBoolean("exists", {
        description:
          "An environment of that name is already in the matching project - the panel's `production` maps onto the one every Deplo project starts with.",
      }),
      services: t.field({ type: [PlanServiceRef], resolve: (e) => e.services }),
    }),
  });

export const PlanProjectRef = builder
  .objectRef<PlanProject>("MigrationPlanProject")
  .implement({
    fields: (t) => ({
      sourceId: t.exposeString("sourceId"),
      name: t.exposeString("name"),
      exists: t.exposeBoolean("exists"),
      environments: t.field({
        type: [PlanEnvironmentRef],
        resolve: (p) => p.environments,
      }),
    }),
  });

export const PlanServerRef = builder
  .objectRef<PlanServer>("MigrationPlanServer")
  .implement({
    description:
      "One machine behind the source instance. The FIRST entry is always the host the source instance itself runs on, whose `sourceId` is the empty string - the same key the server mapping and the data cutover use for it.",
    fields: (t) => ({
      sourceId: t.exposeString("sourceId"),
      name: t.exposeString("name"),
      ipAddress: t.exposeString("ipAddress", { nullable: true }),
      cloudflare: t.exposeBoolean("cloudflare", {
        description:
          "That address resolves into Cloudflare's proxy ranges, so it answers as the proxy: no agent can ever be dialled on it, and the machine's own IP has to be given instead.",
      }),
      deploServerId: t.exposeString("deploServerId", {
        nullable: true,
        description:
          "The Deplo server at that same address, or null when Deplo has no agent there. Data cannot be copied off a machine Deplo cannot reach: a volume is read by the agent ON its host, and agents cannot dial each other.",
      }),
      deploServerName: t.exposeString("deploServerName", { nullable: true }),
      deploServerOnline: t.exposeBoolean("deploServerOnline", {
        description:
          "Whether that server's agent answers. A row a failed attempt left behind sits at the same address and is matched all the same, so this - not the id - is what says the machine is ready to be read.",
      }),
    }),
  });

export const PlanMemberRef = builder
  .objectRef<PlanMember>("MigrationPlanMember")
  .implement({
    description:
      "Someone in the team or organization the token reads. Empty when the token belongs to a plain member, which cannot list it.",
    fields: (t) => ({
      email: t.exposeString("email"),
      name: t.exposeString("name"),
      sourceRole: t.exposeString("sourceRole", {
        description:
          "The role they held over there. Shown, never applied: everyone arrives as a plain member and is promoted on purpose.",
      }),
      hasAccount: t.exposeBoolean("hasAccount"),
      avatarUrl: t.exposeString("avatarUrl", { nullable: true }),
      avatarColor: t.exposeString("avatarColor", { nullable: true }),
      inTeam: t.exposeBoolean("inTeam"),
    }),
  });

export const MigrationPlanRef = builder
  .objectRef<MigrationPlan>("MigrationPlan")
  .implement({
    description:
      "What an import would do, read from the source instance without writing anything.",
    fields: (t) => ({
      platform: t.field({
        type: MigrationPlatformEnum,
        description: "Which product answered at that address.",
        resolve: (p) => p.platform,
      }),
      sourceUrl: t.exposeString("sourceUrl"),
      orgName: t.exposeString("orgName", {
        nullable: true,
        description:
          "The team or organization this token reads. A token belongs to one, so importing a second one means a second token.",
      }),
      otherTeams: t.exposeStringList("otherTeams", {
        nullable: true,
        description:
          "The panel's other teams, by name - the ones this token does not cover and that need one of their own. Null when the panel cannot say, which on Coolify it never can.",
      }),
      projects: t.field({ type: [PlanProjectRef], resolve: (p) => p.projects }),
      servers: t.field({ type: [PlanServerRef], resolve: (p) => p.servers }),
      members: t.field({ type: [PlanMemberRef], resolve: (p) => p.members }),
    }),
  });

export const SourceIdentityRef = builder
  .objectRef<SourceIdentity>("MigrationSourceTeam")
  .implement({
    description:
      "Which team of the panel one token reads. A token belongs to exactly one team on both products, so bringing several over takes one token each.",
    fields: (t) => ({
      platform: t.field({
        type: MigrationPlatformEnum,
        resolve: (i) => i.platform,
      }),
      teamId: t.exposeString("teamId", {
        nullable: true,
        description:
          "The team's own id over there, which is how two tokens of ONE team are told apart from two tokens of two teams. Null when the panel would not say.",
      }),
      teamName: t.exposeString("teamName", { nullable: true }),
      otherTeams: t.exposeStringList("otherTeams", {
        nullable: true,
        description:
          "The panel's other teams, by name, so the ones no token covers yet can be named. Null means the panel cannot say - always the case on Coolify, whose team listing is filtered down to the token's own team.",
      }),
    }),
  });
