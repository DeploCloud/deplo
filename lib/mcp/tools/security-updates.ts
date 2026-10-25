import * as z from "zod";
import { tool, type McpToolDef } from "./tool-def";

const UPDATE_FIELDS = /* GraphQL */ `
  vulnId
  cve
  level
  cvss
  summary
  ecosystem
  packageName
  installedVersion
  fixedVersion
  fix
  actionable
  ignored
  ignoredUntil
  ignoreReason
  service
  osvUrl
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
      "Known security flaws in what an app or database runs, with how to fix each. With neither id, every app and database of the team that has updates to apply, most urgent first.",
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
          checkedAt unreadable count exploited newerTag updates { ${UPDATE_FIELDS} }
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
];
