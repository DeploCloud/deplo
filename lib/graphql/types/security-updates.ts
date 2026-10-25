import { builder } from "../builder";
import {
  appSecurityUpdates,
  databaseSecurityUpdates,
  type SecurityUpdate,
  type SecurityUpdates,
} from "@/lib/data/security-updates/read";
import {
  ignoreSecurityUpdate,
  unignoreSecurityUpdate,
} from "@/lib/data/security-updates/ignore";
import {
  securityUpdatesOverview,
  type SecuritySubject,
} from "@/lib/data/security-updates/overview";
import {
  securityUpdatesStatus,
  setSecurityUpdatesEnabled,
  type SecurityUpdatesStatus,
} from "@/lib/data/security-updates/settings";

const SecurityLevelEnum = builder.enumType("SecurityLevel", {
  description:
    "How serious a security update is: `exploited` is on CISA's known-exploited list, `critical` and `high` come from its CVSS score or advisory.",
  values: ["exploited", "critical", "high"] as const,
});

const SecurityFixEnum = builder.enumType("SecurityFix", {
  description:
    "How the team gets the fix. `code`: update the dependency in the app's own code. `rebuild`: rebuild on a fresh base image. `update`: redeploy to pull a newer build of the image. `newer_tag`: move to a newer version of the image. `deplo`: comes with a Deplo update. `none`: nobody has shipped a fix yet.",
  values: ["code", "rebuild", "update", "newer_tag", "deplo", "none"] as const,
});

const SecurityUpdateRef = builder
  .objectRef<SecurityUpdate>("SecurityUpdate")
  .implement({
    description:
      "One known vulnerability in a package an app or database runs.",
    fields: (t) => ({
      vulnId: t.exposeString("vulnId", {
        description:
          "The OSV id, for example GHSA-xvch-5gv4-984h or DEBIAN-CVE-2024-5535.",
      }),
      cve: t.exposeString("cve", { nullable: true }),
      level: t.field({ type: SecurityLevelEnum, resolve: (u) => u.level }),
      cvss: t.exposeFloat("cvss", { nullable: true }),
      summary: t.exposeString("summary"),
      ecosystem: t.exposeString("ecosystem"),
      packageName: t.exposeString("packageName"),
      installedVersion: t.exposeString("installedVersion"),
      fixedVersion: t.exposeString("fixedVersion", { nullable: true }),
      fix: t.field({ type: SecurityFixEnum, resolve: (u) => u.fix }),
      ignored: t.exposeBoolean("ignored", {
        description:
          "Set aside by the team until `ignoredUntil`: still listed, never counted or alerted.",
      }),
      ignoredUntil: t.exposeString("ignoredUntil", { nullable: true }),
      ignoreReason: t.exposeString("ignoreReason", { nullable: true }),
      ignoredBy: t.exposeString("ignoredBy", { nullable: true }),
      actionable: t.exposeBoolean("actionable", {
        description:
          "True when the team can act on it now, or it is already used in attacks. Only these are counted and alerted.",
      }),
      service: t.exposeString("service", {
        description:
          "The compose service it was found in; empty for a single-container app.",
      }),
      osvUrl: t.exposeString("osvUrl"),
    }),
  });

const SecurityUpdatesRef = builder
  .objectRef<SecurityUpdates>("SecurityUpdates")
  .implement({
    description:
      "The security updates of one app or database, from the package lists of the images it runs. https://deplo.build/docs/guides/observability/security-updates",
    fields: (t) => ({
      checkedAt: t.exposeString("checkedAt", {
        nullable: true,
        description:
          "The oldest check behind this answer; null until every image was checked once.",
      }),
      unreadable: t.exposeStringList("unreadable", {
        description:
          "Why some of its images could not be read: too_large, low_disk, low_memory, timed_out, unsupported or failed.",
      }),
      count: t.exposeInt("count", {
        description: "Updates the team can act on, or already used in attacks.",
      }),
      exploited: t.exposeInt("exploited"),
      newerTag: t.exposeString("newerTag", {
        nullable: true,
        description:
          "A newer version of the image on the same line, when the registry lists one.",
      }),
      updates: t.field({
        type: [SecurityUpdateRef],
        resolve: (s) => s.updates,
      }),
    }),
  });

const SecuritySubjectRef = builder
  .objectRef<SecuritySubject>("SecuritySubject")
  .implement({
    description: "An app or database with security updates to apply.",
    fields: (t) => ({
      kind: t.exposeString("kind", { description: "`app` or `database`." }),
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      slug: t.exposeString("slug", {
        nullable: true,
        description: "The app's slug, for its address; null for a database.",
      }),
      count: t.exposeInt("count"),
      exploited: t.exposeInt("exploited"),
    }),
  });

const SecurityUpdatesStatusRef = builder
  .objectRef<SecurityUpdatesStatus>("SecurityUpdatesStatus")
  .implement({
    description: "The instance-wide switch and the health of the last checks.",
    fields: (t) => ({
      enabled: t.exposeBoolean("enabled"),
      lastCheckedAt: t.exposeString("lastCheckedAt", { nullable: true }),
      failingSince: t.exposeString("failingSince", {
        nullable: true,
        description:
          "Since when OSV.dev could not be reached; null while checks succeed.",
      }),
    }),
  });

builder.queryFields((t) => ({
  securityUpdates: t.field({
    type: SecurityUpdatesRef,
    nullable: true,
    authScopes: { loggedIn: true },
    description:
      "The security updates of one app (`appId`) or managed database (`databaseId`) in the active team. Null when it is out of reach or the instance turned checks off.",
    args: {
      appId: t.arg.id({ required: false }),
      databaseId: t.arg.id({ required: false }),
    },
    resolve: (_r, { appId, databaseId }) =>
      appId
        ? appSecurityUpdates(String(appId))
        : databaseId
          ? databaseSecurityUpdates(String(databaseId))
          : null,
  }),
  securityUpdatesOverview: t.field({
    type: [SecuritySubjectRef],
    authScopes: { loggedIn: true },
    description:
      "Every app and database in the active team with security updates to apply, most urgent first. Empty when the instance turned checks off.",
    resolve: () => securityUpdatesOverview(),
  }),
  securityUpdatesStatus: t.field({
    type: SecurityUpdatesStatusRef,
    authScopes: { instanceAdmin: true },
    resolve: () => securityUpdatesStatus(),
  }),
}));

const ignoreArgs = (
  t: Parameters<Parameters<typeof builder.mutationFields>[0]>[0],
) => ({
  appId: t.arg.id({ required: false }),
  databaseId: t.arg.id({ required: false }),
  vulnIds: t.arg.stringList({
    required: true,
    description:
      "The advisory ids (`vulnId`) to act on: every advisory of one package, usually.",
  }),
});

builder.mutationFields((t) => ({
  ignoreSecurityUpdate: t.boolean({
    authScopes: { capability: "ignore_security_updates" },
    description:
      "Set advisories aside on one app or database for 30, 90 (default) or 180 days, with an optional reason. They stay listed but stop counting and alerting until then; a new advisory still shows. Recorded in Activity.",
    args: {
      ...ignoreArgs(t),
      reason: t.arg.string({ required: false }),
      days: t.arg.int({ required: false }),
    },
    resolve: async (_r, a) => {
      await ignoreSecurityUpdate({
        appId: a.appId ? String(a.appId) : null,
        databaseId: a.databaseId ? String(a.databaseId) : null,
        vulnIds: a.vulnIds,
        reason: a.reason,
        days: a.days,
      });
      return true;
    },
  }),
  unignoreSecurityUpdate: t.boolean({
    authScopes: { capability: "ignore_security_updates" },
    description:
      "Count and alert on advisories set aside with ignoreSecurityUpdate again. Recorded in Activity.",
    args: ignoreArgs(t),
    resolve: async (_r, a) => {
      await unignoreSecurityUpdate({
        appId: a.appId ? String(a.appId) : null,
        databaseId: a.databaseId ? String(a.databaseId) : null,
        vulnIds: a.vulnIds,
      });
      return true;
    },
  }),
  setSecurityUpdatesEnabled: t.field({
    type: SecurityUpdatesStatusRef,
    authScopes: { instanceAdmin: true },
    description:
      "Turn security update checks on or off for the whole instance. On, Deplo sends OSV.dev the name and version of each package the team's images contain, never an app name or anything that identifies this Deplo. Recorded in Activity.",
    args: { enabled: t.arg.boolean({ required: true }) },
    resolve: (_r, { enabled }) => setSecurityUpdatesEnabled(enabled),
  }),
}));
