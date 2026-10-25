import {
  pgTable,
  text,
  integer,
  boolean,
  index,
  primaryKey,
  foreignKey,
} from "drizzle-orm/pg-core";

import { isoTimestamptz } from "../columns";
import { apps } from "./apps";
import { databases } from "./databases";
import { appPreviews } from "./deployments";
import { teams } from "./identity";
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
    registryCheckedAt: isoTimestamptz("registry_checked_at"),
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
    fixedVersion: text("fixed_version"),
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
