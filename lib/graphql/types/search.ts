import { builder } from "../builder";
import { AppStatusEnum, DatabaseTypeEnum, DomainStatusEnum } from "./enums";
import { DatabaseStatusEnum } from "./database";
import { ServerStatusEnum } from "./server";
import {
  search,
  type SearchApp,
  type SearchCron,
  type SearchDatabase,
  type SearchDomain,
  type SearchEnvironment,
  type SearchFolder,
  type SearchMember,
  type SearchProject,
  type SearchResults,
  type SearchServer,
  type SearchTeam,
  type SearchTemplate,
} from "@/lib/data/search";

/* ------------------------------------------------------------------ */
/* Enums                                                               */
/* ------------------------------------------------------------------ */

const SearchKindEnum = builder.enumType("SearchKind", {
  description: "One kind of thing a search can return.",
  values: [
    "app",
    "database",
    "server",
    "project",
    "environment",
    "folder",
    "domain",
    "member",
    "cron",
    "template",
  ] as const,
});

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

const SearchTeamRef = builder.objectRef<SearchTeam>("SearchTeam").implement({
  description: "The team a search hit was found in.",
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
    slug: t.exposeString("slug"),
  }),
});

const SearchAppRef = builder.objectRef<SearchApp>("SearchApp").implement({
  description:
    "An app a search matched. Deliberately small: enough to recognise it and " +
    "to read it in full with `app(slug:)` afterwards.",
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
    slug: t.exposeString("slug"),
    logo: t.exposeString("logo", { nullable: true }),
    status: t.field({ type: AppStatusEnum, resolve: (a) => a.status }),
    productionUrl: t.exposeString("productionUrl", { nullable: true }),
    team: t.field({ type: SearchTeamRef, resolve: (a) => a.team }),
  }),
});

const SearchDatabaseRef = builder
  .objectRef<SearchDatabase>("SearchDatabase")
  .implement({
    description: "A database a search matched.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      logo: t.exposeString("logo", { nullable: true }),
      type: t.field({ type: DatabaseTypeEnum, resolve: (d) => d.type }),
      status: t.field({ type: DatabaseStatusEnum, resolve: (d) => d.status }),
      team: t.field({ type: SearchTeamRef, resolve: (d) => d.team }),
    }),
  });

const SearchServerRef = builder
  .objectRef<SearchServer>("SearchServer")
  .implement({
    description:
      "A server a search matched. Servers are the one resource shared across " +
      "teams, so a hit names none.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      host: t.exposeString("host"),
      status: t.field({ type: ServerStatusEnum, resolve: (s) => s.status }),
    }),
  });

const SearchProjectRef = builder
  .objectRef<SearchProject>("SearchProject")
  .implement({
    description: "A project a search matched.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      slug: t.exposeString("slug"),
      appCount: t.exposeInt("appCount"),
      team: t.field({ type: SearchTeamRef, resolve: (p) => p.team }),
    }),
  });

const SearchEnvironmentRef = builder
  .objectRef<SearchEnvironment>("SearchEnvironment")
  .implement({
    description: "An environment a search matched, with the project it is in.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      slug: t.exposeString("slug"),
      kind: t.exposeString("kind"),
      projectId: t.exposeID("projectId"),
      projectName: t.exposeString("projectName"),
      team: t.field({ type: SearchTeamRef, resolve: (e) => e.team }),
    }),
  });

const SearchFolderRef = builder
  .objectRef<SearchFolder>("SearchFolder")
  .implement({
    description:
      "A folder a search matched. Folders have no slug: open one by id.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      appCount: t.exposeInt("appCount"),
      team: t.field({ type: SearchTeamRef, resolve: (f) => f.team }),
    }),
  });

const SearchDomainRef = builder
  .objectRef<SearchDomain>("SearchDomain")
  .implement({
    description: "A domain a search matched, with the app that serves it.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      appSlug: t.exposeString("appSlug"),
      appName: t.exposeString("appName"),
      status: t.field({ type: DomainStatusEnum, resolve: (d) => d.status }),
      team: t.field({ type: SearchTeamRef, resolve: (d) => d.team }),
    }),
  });

const SearchMemberRef = builder
  .objectRef<SearchMember>("SearchMember")
  .implement({
    description:
      "A team member a search matched. Name and username only - a search must " +
      "never turn a name into an email address.",
    fields: (t) => ({
      userId: t.exposeID("userId"),
      name: t.exposeString("name"),
      username: t.exposeString("username"),
      roleName: t.exposeString("roleName", { nullable: true }),
      team: t.field({ type: SearchTeamRef, resolve: (m) => m.team }),
    }),
  });

const SearchCronRef = builder.objectRef<SearchCron>("SearchCron").implement({
  description:
    "A cron job a search matched, with the app or database it runs on.",
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
    schedule: t.exposeString("schedule"),
    enabled: t.exposeBoolean("enabled"),
    targetKind: t.exposeString("targetKind"),
    targetRef: t.exposeString("targetRef", {
      description:
        "The app's SLUG or the database's ID - the deep link, either way.",
    }),
    targetName: t.exposeString("targetName"),
    team: t.field({ type: SearchTeamRef, resolve: (c) => c.team }),
  }),
});

const SearchTemplateRef = builder
  .objectRef<SearchTemplate>("SearchTemplate")
  .implement({
    description:
      "A catalogue template a search matched. Public, so it names no team.",
    fields: (t) => ({
      slug: t.exposeString("slug"),
      name: t.exposeString("name"),
      logo: t.exposeString("logo", { nullable: true }),
    }),
  });

const SearchResultsRef = builder
  .objectRef<SearchResults>("SearchResults")
  .implement({
    description: "What a search found, grouped by kind. At most 50 of each.",
    fields: (t) => ({
      apps: t.field({ type: [SearchAppRef], resolve: (r) => r.apps }),
      databases: t.field({
        type: [SearchDatabaseRef],
        resolve: (r) => r.databases,
      }),
      servers: t.field({ type: [SearchServerRef], resolve: (r) => r.servers }),
      projects: t.field({
        type: [SearchProjectRef],
        resolve: (r) => r.projects,
      }),
      environments: t.field({
        type: [SearchEnvironmentRef],
        resolve: (r) => r.environments,
      }),
      folders: t.field({ type: [SearchFolderRef], resolve: (r) => r.folders }),
      domains: t.field({ type: [SearchDomainRef], resolve: (r) => r.domains }),
      members: t.field({ type: [SearchMemberRef], resolve: (r) => r.members }),
      cronJobs: t.field({ type: [SearchCronRef], resolve: (r) => r.cronJobs }),
      templates: t.field({
        type: [SearchTemplateRef],
        resolve: (r) => r.templates,
      }),
    }),
  });

/* ------------------------------------------------------------------ */
/* Query                                                               */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  search: t.field({
    type: SearchResultsRef,
    authScopes: { loggedIn: true },
    description:
      "Find anything by name, slug or id across EVERY team the caller can " +
      "reach - the one read in deplo that is not scoped to the active team. " +
      "Each hit says which team it is in. Separators and case are ignored, so " +
      '"better auth" finds `better-auth-docs`. Hits from the active team come ' +
      "first, then the closest match. Teams the caller cannot enter right now " +
      "(an unmet two-factor policy, a narrowed token) contribute nothing rather " +
      "than failing the search.",
    args: {
      q: t.arg.string({
        required: true,
        description: "Part of a name, slug or id. Blank finds nothing.",
      }),
      kinds: t.arg({
        type: [SearchKindEnum],
        required: false,
        description:
          "Which kinds to look through. Omitted means all ten - and each is a " +
          "separate read PER TEAM, so name the ones you need.",
      }),
    },
    resolve: (_r, { q, kinds }) => search(q, kinds ?? undefined),
  }),
}));
