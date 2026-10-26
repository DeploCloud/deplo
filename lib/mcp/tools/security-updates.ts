import * as z from "zod";
import { tool, type McpToolDef } from "./tool-def";

// One entry per package or image, the way the dashboard counts them, advisories inside.
const GROUP_FIELDS = /* GraphQL */ `
  key
  image
  imageRef
  service
  packageName
  installedVersion
  fixedVersion
  via
  level
  fix
  counted
  exploited
  ignored
  advisories {
    vulnId
    cve
    level
    cvss
    epss
    summary
    ignoredUntil
    ignoreReason
    osvUrl
  }
  pullRequest {
    number
    url
  }
`;

const SUBJECT = {
  appId: z
    .string()
    .optional()
    .describe("The app's id, as returned by list_apps."),
  databaseId: z
    .string()
    .optional()
    .describe("The database's id, as returned by list_databases."),
};

// https://deplo.build/docs/guides/observability/security-updates
export const SECURITY_UPDATES: McpToolDef[] = [
  tool({
    name: "list_security_updates",
    title: "List security updates",
    description:
      "Known security flaws in what an app or database runs: one entry per package or image, with its fix and advisories; only `counted` ones are in `count`. With no id, every app and database with updates.",
    group: "Security",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object(SUBJECT),
    variables: (a) => ({
      appId: a.appId ?? null,
      databaseId: a.databaseId ?? null,
      one: Boolean(a.appId || a.databaseId),
    }),
    query: /* GraphQL */ `
      query McpListSecurityUpdates($appId: ID, $databaseId: ID, $one: Boolean!) {
        securityUpdates(appId: $appId, databaseId: $databaseId) @include(if: $one) {
          checkedAt checking unreadable count exploited newerTag canOpenPullRequests groups { ${GROUP_FIELDS} }
        }
        securityUpdatesOverview @skip(if: $one) { kind id name count exploited }
      }
    `,
  }),
  tool({
    name: "ignore_security_update",
    title: "Ignore a security update",
    description:
      "Set advisories aside on one app or database for 30, 90 or 180 days with a reason: they stop counting and alerting until then. Pass every vulnId of the package to ignore the whole update.",
    group: "Security",
    requires: "ignore_security_updates",
    idempotent: true,
    input: z.object({
      ...SUBJECT,
      vulnIds: z
        .array(z.string())
        .min(1)
        .describe("vulnId values from list_security_updates."),
      reason: z
        .string()
        .optional()
        .describe("Why the team accepts it, shown in Activity."),
      days: z.union([z.literal(30), z.literal(90), z.literal(180)]).optional(),
    }),
    query: /* GraphQL */ `
      mutation McpIgnoreSecurityUpdate(
        $appId: ID
        $databaseId: ID
        $vulnIds: [String!]!
        $reason: String
        $days: Int
      ) {
        ignoreSecurityUpdate(
          appId: $appId
          databaseId: $databaseId
          vulnIds: $vulnIds
          reason: $reason
          days: $days
        )
      }
    `,
  }),
  tool({
    name: "unignore_security_update",
    title: "Stop ignoring a security update",
    description:
      "Bring ignored advisories of one app or database back at once: they count and alert again. Pass the vulnIds that ignore_security_update set aside.",
    group: "Security",
    requires: "ignore_security_updates",
    idempotent: true,
    input: z.object({
      ...SUBJECT,
      vulnIds: z
        .array(z.string())
        .min(1)
        .describe("vulnId values from list_security_updates."),
    }),
    query: /* GraphQL */ `
      mutation McpUnignoreSecurityUpdate(
        $appId: ID
        $databaseId: ID
        $vulnIds: [String!]!
      ) {
        unignoreSecurityUpdate(
          appId: $appId
          databaseId: $databaseId
          vulnIds: $vulnIds
        )
      }
    `,
  }),
  tool({
    name: "open_security_pull_request",
    title: "Open a security pull request",
    description:
      "Open a pull request on an app's GitHub repository moving one npm package (a `code` or `build_only` entry) to its `fixedVersion`. Answers `accessUrl` instead when GitHub must first grant Deplo write access.",
    group: "Security",
    requires: "open_security_prs",
    idempotent: true,
    input: z.object({
      appId: z.string().describe("The app's id, as returned by list_apps."),
      packageName: z
        .string()
        .describe("packageName from list_security_updates."),
    }),
    query: /* GraphQL */ `
      mutation McpOpenSecurityPullRequest($appId: ID!, $packageName: String!) {
        openSecurityPullRequest(appId: $appId, packageName: $packageName) {
          number
          url
          accessUrl
        }
      }
    `,
  }),
];
