import {
  pgTable,
  text,
  integer,
  boolean,
  index,
  primaryKey,
  foreignKey,
  unique,
} from "drizzle-orm/pg-core";

import { isoTimestamptz } from "../columns";
import { apps } from "./apps";
import { databases } from "./databases";
import { appPreviews } from "./deployments";
import { teams, users } from "./identity";
import { servers } from "./servers";

// One package read per image, keyed by its content-addressed id (ADR-0038).
export const imageInventories = pgTable("image_inventories", {
  imageId: text("image_id").primaryKey(),
  status: text("status").notNull(),
  error: text("error").notNull().default(""),
  distroId: text("distro_id").notNull().default(""),
  distroVersion: text("distro_version").notNull().default(""),
  workingDir: text("working_dir").notNull().default(""),
  scannerVersion: text("scanner_version").notNull().default(""),
  scannedAt: isoTimestamptz("scanned_at").notNull(),
  // Read by an agent that marks build-only packages and who pulls each in (`image-inventory.deps`).
  depsRead: boolean("deps_read").notNull().default(false),
});

export const imageInventoryPackages = pgTable(
  "image_inventory_packages",
  {
    imageId: text("image_id")
      .notNull()
      .references(() => imageInventories.imageId, { onDelete: "cascade" }),
    purl: text("purl").notNull(),
    location: text("location").notNull().default(""),
    type: text("type").notNull(),
    name: text("name").notNull(),
    version: text("version").notNull(),
    // Reachable only from the app's devDependencies: built with, never run.
    buildOnly: boolean("build_only").notNull().default(false),
    // Who pulls it in, parent first up to the app's own dependency, tab-separated; "" when direct.
    via: text("via").notNull().default(""),
  },
  (t) => [primaryKey({ columns: [t.imageId, t.purl, t.location] })],
);

// What runs where: one row per container service of an app, preview or database on a server.
export const workloadImages = pgTable(
  "workload_images",
  {
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    workloadId: text("workload_id").notNull(),
    service: text("service").notNull().default(""),
    kind: text("kind").notNull(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    appId: text("app_id").references(() => apps.id, { onDelete: "cascade" }),
    previewId: text("preview_id").references(() => appPreviews.id, {
      onDelete: "cascade",
    }),
    databaseId: text("database_id").references(() => databases.id, {
      onDelete: "cascade",
    }),
    imageRef: text("image_ref").notNull(),
    imageId: text("image_id").notNull(),
    repoDigest: text("repo_digest").notNull().default(""),
    running: boolean("running").notNull(),
    // ok | private, NULL until the registry answered once; a failed read keeps the last answer.
    registryStatus: text("registry_status"),
    // The registry's current digest for image_ref's tag, and a newer tag of the same line.
    registryDigest: text("registry_digest"),
    newerTag: text("newer_tag"),
    newerTagDigest: text("newer_tag_digest"),
    registryCheckedAt: isoTimestamptz("registry_checked_at"),
    // The newer build last read before offering Update (repository@digest), and how it went.
    candidateRef: text("candidate_ref"),
    candidateImageId: text("candidate_image_id"),
    candidateStatus: text("candidate_status"),
    candidateCheckedAt: isoTimestamptz("candidate_checked_at"),
    seenAt: isoTimestamptz("seen_at").notNull(),
    // NULL until the image's packages were matched; a new image resets it.
    checkedAt: isoTimestamptz("checked_at"),
  },
  (t) => [
    primaryKey({ columns: [t.serverId, t.workloadId, t.service] }),
    index("workload_images_team_idx").on(t.teamId),
    index("workload_images_image_idx").on(t.imageId),
  ],
);

// The OSV record of one vulnerability for one affected package, cached until OSV modifies it.
export const osvAffected = pgTable(
  "osv_affected",
  {
    vulnId: text("vuln_id").notNull(),
    ecosystem: text("ecosystem").notNull(),
    name: text("name").notNull(),
    cve: text("cve"),
    // critical | high | medium | low, from the best source OSV has; NULL when it has none.
    severity: text("severity"),
    // CVSS base score times ten, NULL when OSV has none.
    cvssTenths: integer("cvss_tenths"),
    summary: text("summary").notNull().default(""),
    modified: text("modified").notNull(),
    fetchedAt: isoTimestamptz("fetched_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.vulnId, t.ecosystem, t.name] })],
);

// Each release line an advisory covers, so the fix shown is the one on the installed line.
export const osvRanges = pgTable(
  "osv_ranges",
  {
    vulnId: text("vuln_id").notNull(),
    ecosystem: text("ecosystem").notNull(),
    name: text("name").notNull(),
    seq: integer("seq").notNull(),
    introduced: text("introduced").notNull(),
    fixed: text("fixed"),
    lastAffected: text("last_affected"),
  },
  (t) => [
    primaryKey({
      name: "osv_ranges_pk",
      columns: [t.vulnId, t.ecosystem, t.name, t.seq],
    }),
    foreignKey({
      name: "osv_ranges_affected_fk",
      columns: [t.vulnId, t.ecosystem, t.name],
      foreignColumns: [
        osvAffected.vulnId,
        osvAffected.ecosystem,
        osvAffected.name,
      ],
    }).onDelete("cascade"),
  ],
);

// FIRST's EPSS: the chance a CVE is exploited in the next 30 days, read once a day.
export const epssScores = pgTable("epss_scores", {
  cveId: text("cve_id").primaryKey(),
  // Both in hundredths of a percent: 1234 is 12.34%.
  scoreBp: integer("score_bp").notNull(),
  percentileBp: integer("percentile_bp").notNull(),
  fetchedAt: isoTimestamptz("fetched_at").notNull(),
});

// CISA's known-exploited list, replaced whole once a day.
export const kevCves = pgTable("kev_cves", {
  cveId: text("cve_id").primaryKey(),
});

// The open security updates of one workload service; a fixed one is deleted.
export const securityFindings = pgTable(
  "security_findings",
  {
    serverId: text("server_id").notNull(),
    workloadId: text("workload_id").notNull(),
    service: text("service").notNull(),
    vulnId: text("vuln_id").notNull(),
    ecosystem: text("ecosystem").notNull(),
    packageName: text("package_name").notNull(),
    installedVersion: text("installed_version").notNull(),
    fixedVersion: text("fixed_version"),
    location: text("location").notNull().default(""),
    via: text("via").notNull().default(""),
    level: text("level").notNull(),
    fix: text("fix").notNull(),
    firstSeenAt: isoTimestamptz("first_seen_at").notNull(),
    alertedAt: isoTimestamptz("alerted_at"),
  },
  (t) => [
    primaryKey({
      name: "security_findings_pk",
      columns: [
        t.serverId,
        t.workloadId,
        t.service,
        t.vulnId,
        t.ecosystem,
        t.packageName,
        t.installedVersion,
      ],
    }),
    foreignKey({
      name: "security_findings_workload_fk",
      columns: [t.serverId, t.workloadId, t.service],
      foreignColumns: [
        workloadImages.serverId,
        workloadImages.workloadId,
        workloadImages.service,
      ],
    }).onDelete("cascade"),
  ],
);

// A team's decision to leave one advisory on an app or database alone until it expires.
export const securityIgnores = pgTable(
  "security_ignores",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    appId: text("app_id").references(() => apps.id, { onDelete: "cascade" }),
    databaseId: text("database_id").references(() => databases.id, {
      onDelete: "cascade",
    }),
    vulnId: text("vuln_id").notNull(),
    reason: text("reason").notNull().default(""),
    expiresAt: isoTimestamptz("expires_at").notNull(),
    createdBy: text("created_by").notNull(),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    unique("security_ignores_subject_vuln")
      .on(t.appId, t.databaseId, t.vulnId)
      .nullsNotDistinct(),
  ],
);

// A pull request Deplo opened to move one dependency to its fix, so it is offered once.
export const securityPullRequests = pgTable(
  "security_pull_requests",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    packageName: text("package_name").notNull(),
    version: text("version").notNull(),
    number: integer("number").notNull(),
    url: text("url").notNull(),
    createdBy: text("created_by").notNull(),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.appId, t.packageName, t.version] })],
);
