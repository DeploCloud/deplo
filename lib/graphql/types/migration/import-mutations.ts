import { builder } from "../../builder";
import { MigrationPlatformEnum } from "./enums";
import { ConnectInputRef, PlacementInput, ServerChoiceInput } from "./inputs";
import { MigrationPlanRef, SourceIdentityRef } from "./plan-types";
import { ImportProjectResultRef, InviteRef } from "./run-types";
import { importMigrationMembers } from "@/lib/data/migration-import/member-invites";
import { importMigrationProject } from "@/lib/data/migration-import/project-import";
import { beginMigration } from "@/lib/data/migration-import/run-lifecycle";
import {
  identifyMigrationSource,
  scanMigrationSource,
} from "@/lib/data/migration-import/scan";

builder.mutationFields((t) => ({
  identifyMigrationSource: t.field({
    type: SourceIdentityRef,
    // Reading the panel touches no team, so the instance's admins may from any
    // page of theirs; landing in a team keeps its own gate.
    authScopes: {
      $any: { instanceAdmin: true, capability: "create_projects" },
    },
    description:
      "WHICH team a token reads, without reading it all. A token covers one team of the panel, so bringing several over takes one token each, and this is what lets the wizard collect them without paying for a full scan per token. Refuses a token that cannot read values, exactly as the scan does. Writes nothing.",
    args: { input: t.arg({ type: ConnectInputRef, required: true }) },
    resolve: (_r, { input }) =>
      identifyMigrationSource({
        url: input.url,
        apiKey: input.apiKey,
        kind: input.kind ?? undefined,
      }),
  }),
  scanMigrationSource: t.field({
    type: MigrationPlanRef,
    authScopes: {
      $any: { instanceAdmin: true, capability: "create_projects" },
    },
    description:
      "Read a source panel and describe what an import would do. Works out which product it is when `kind` is omitted. Writes NOTHING, here or there. The per-service detail calls happen now, not at import time, so the preview can already say which hostname belongs to another team, which compose file needs a grant you do not hold, and what has no equivalent here. Answers about the request's team, which needs `create_projects` there - or, with `newTeam`, about a team not made yet, which an instance admin may ask from any team of theirs.",
    args: {
      input: t.arg({ type: ConnectInputRef, required: true }),
      newTeam: t.arg.boolean({
        required: false,
        description:
          "Describe the import into a team that does not exist yet: nothing counts as already here, and every hostname another team serves is another team's. Instance admins only; the wizard sends it for a source team it will land in a team made at Start.",
      }),
    },
    resolve: (_r, { input, newTeam }) =>
      scanMigrationSource(
        {
          url: input.url,
          apiKey: input.apiKey,
          kind: input.kind ?? undefined,
        },
        { newTeam: newTeam ?? false },
      ),
  }),
  beginMigration: t.field({
    type: "String",
    authScopes: { capability: "create_projects" },
    description:
      "Open an import run and return its id. Any run this team left open (a closed tab) is closed as failed first, so the history never shows two live imports.",
    args: {
      url: t.arg.string({ required: true }),
      orgName: t.arg.string({ required: false }),
      kind: t.arg({ type: MigrationPlatformEnum, required: false }),
    },
    resolve: (_r, { url, orgName, kind }) =>
      beginMigration({ url, orgName, kind: kind ?? undefined }),
  }),
  importMigrationProject: t.field({
    type: ImportProjectResultRef,
    authScopes: { capability: "create_projects" },
    description:
      "Import ONE project from the source panel into the active team: its environments, apps, compose stacks, databases, variables, domains, config files, volumes, resource limits, basic-auth users and crons. Nothing is deployed - the source instance is still answering those hostnames. Anything already here is skipped by name, so running it again resumes an interrupted import instead of duplicating it. One object failing never stops the rest: it becomes a line in the report.",
    args: {
      input: t.arg({ type: ConnectInputRef, required: true }),
      runId: t.arg.string({ required: true }),
      projectId: t.arg.string({
        required: true,
        description: "The panel's `projectId` to import.",
      }),
      servers: t.arg({ type: [ServerChoiceInput], required: false }),
      serviceIds: t.arg.stringList({
        required: false,
        description:
          "Which of the project's services to import, by their id over there (the `sourceId` a scan reports). Omit to import all of them. A service left out is left out silently - it is a choice, not an outcome, so it produces no report line. An environment nothing was picked from is not created.",
      }),
      placements: t.arg({
        type: [PlacementInput],
        required: false,
        description:
          "Where each service lands, one entry per service. Wins over `servers`, which stays the fallback for anything not listed here. Both are about where a service RUNS; where its data is READ FROM is derived from that machine's own address and is never a caller's choice. A server this team cannot deploy to is refused into a report line, never used.",
      }),
    },
    resolve: (
      _r,
      { input, runId, projectId, servers, serviceIds, placements },
    ) =>
      importMigrationProject({
        url: input.url,
        apiKey: input.apiKey,
        kind: input.kind ?? undefined,
        runId,
        projectId,
        servers: servers?.map((s) => ({ from: s.from, to: s.to })),
        serviceIds: serviceIds ?? undefined,
        placements: placements?.map((p) => ({
          serviceId: p.serviceId,
          serverId: p.serverId,
          buildServerId: p.buildServerId ?? null,
          // NOT `?? null` like the line above it: for a port, absent and null are
          // two different instructions (keep the source's, publish nothing), so
          // an omitted field has to stay undefined all the way down.
          exposedPort: p.exposedPort,
        })),
      }),
  }),
  importMigrationMembers: t.field({
    type: [InviteRef],
    authScopes: { instanceAdmin: true },
    description:
      "Bring the source team's people over. Someone who already has a Deplo account is added to this team; everyone else gets a single-use registration link to send them. Passwords cannot travel in either direction, and everyone arrives as a plain member whatever they were over there - the report says who was an owner or admin so it can be granted on purpose.",
    args: {
      input: t.arg({ type: ConnectInputRef, required: true }),
      runId: t.arg.string({ required: true }),
    },
    resolve: (_r, { input, runId }) =>
      importMigrationMembers({
        url: input.url,
        apiKey: input.apiKey,
        kind: input.kind ?? undefined,
        runId,
      }),
  }),
}));
