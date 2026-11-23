import {
  pgTable,
  text,
  integer,
  boolean,
  bigint,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { isoTimestamptz } from "../columns";
import { apps } from "./apps";
import { dnsProviders } from "./dns-providers";
import { teams, users } from "./identity";
import { servers } from "./servers";

// Several servers that act as one (spec #176). A null leader server means Deplo's own machine.
export const clusters = pgTable("clusters", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  allTeams: boolean("all_teams").notNull().default(true),
  leaderServerId: text("leader_server_id").references(() => servers.id, {
    onDelete: "set null",
  }),
  leaderEpoch: integer("leader_epoch").notNull().default(0),
  // Set while Deplo's own machine leads because the leader's server does not answer.
  leaderTakeoverAt: isoTimestamptz("leader_takeover_at"),
  // The team whose Activity carries what Deplo says about the leader.
  leaderTeamId: text("leader_team_id").references(() => teams.id, {
    onDelete: "set null",
  }),
  // The last leader event this control plane applied; a reconnect replays from here.
  eventSeq: bigint("event_seq", { mode: "number" }).notNull().default(0),
  // While Deplo's machine stands in: the stored leader's last event applied, so handing back replays what came after.
  resumeEventSeq: bigint("resume_event_seq", { mode: "number" }),
  // Off: the leader holds no failover bundle, so it moves nothing (ADR-0045).
  failoverEnabled: boolean("failover_enabled").notNull().default(true),
  // On: the stored data of its Apps is copied to every other member, the only way such an App fails over.
  replicationEnabled: boolean("replication_enabled").notNull().default(false),
  // On (only with replication): Apps that keep no data run on every member and visitors are spread over them.
  loadBalancingEnabled: boolean("load_balancing_enabled")
    .notNull()
    .default(false),
  // "nearest" | "most_available"
  loadBalancingMode: text("load_balancing_mode").notNull().default("nearest"),
  // The next answer slot to hand out (ADR-0048): slots only grow, so a port never names two Apps in a row.
  answerSlotNext: integer("answer_slot_next").notNull().default(0),
  // Per server: the passed-on connections its agent carries at once (a quarter may wait), and how many wait per App.
  answerMaxConnections: integer("answer_max_connections")
    .notNull()
    .default(2048),
  answerMaxWaiting: integer("answer_max_waiting").notNull().default(128),
  // The cluster's DNS zone (ADR-0049): how long resolvers keep an answer, and how long a silent server stays in it.
  dnsAnswerTtl: integer("dns_answer_ttl").notNull().default(30),
  dnsDropAfter: integer("dns_drop_after").notNull().default(10),
  // On: each zone gets one certificate for itself and every name one label below it (ADR-0049 phase 3).
  dnsWildcard: boolean("dns_wildcard").notNull().default(true),
  // Where an admin dragged it on the Servers page; null = never placed, after the placed ones.
  position: integer("position"),
  createdAt: isoTimestamptz("created_at").notNull(),
});

export const clusterTeams = pgTable(
  "cluster_teams",
  {
    clusterId: text("cluster_id")
      .notNull()
      .references(() => clusters.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.clusterId, t.teamId] }),
    index("cluster_teams_team_idx").on(t.teamId),
  ],
);

// What is wrong with a cluster, worked out in the background so the Servers page never waits on a leader.
export const clusterWarnings = pgTable(
  "cluster_warnings",
  {
    clusterId: text("cluster_id")
      .notNull()
      .references(() => clusters.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    position: integer("position").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    startLeader: boolean("start_leader").notNull().default(false),
    fixCloudflareToken: boolean("fix_cloudflare_token")
      .notNull()
      .default(false),
    checkedAt: isoTimestamptz("checked_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.clusterId, t.key] })],
);

// The age public key of each leader holding this cluster's bundles; a null server is Deplo's machine.
export const clusterLeaderKeys = pgTable(
  "cluster_leader_keys",
  {
    clusterId: text("cluster_id")
      .notNull()
      .references(() => clusters.id, { onDelete: "cascade" }),
    publicKey: text("public_key").notNull(),
    serverId: text("server_id").references(() => servers.id, {
      onDelete: "cascade",
    }),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.clusterId, t.publicKey] })],
);

// The deployment whose failover bundle each leader key holds for a workload (ADR-0045); a relink compares and resends.
export const failoverBundlePushes = pgTable(
  "failover_bundle_pushes",
  {
    workloadKind: text("workload_kind").notNull(),
    workloadId: text("workload_id").notNull(),
    keyFingerprint: text("key_fingerprint").notNull(),
    deploymentId: text("deployment_id").notNull(),
    // The bundle under DEPLO_SECRET, so a new leader key can be sealed to it without a redeploy.
    bundleEnc: text("bundle_enc").notNull(),
    // Null until the leader acknowledged it.
    pushedAt: isoTimestamptz("pushed_at"),
  },
  (t) => [
    primaryKey({ columns: [t.workloadKind, t.workloadId, t.keyFingerprint] }),
    index("failover_bundle_pushes_key_idx").on(t.keyFingerprint),
  ],
);

// A server in a cluster: at most one cluster per server, so the server id is the key.
export const clusterMembers = pgTable(
  "cluster_members",
  {
    serverId: text("server_id")
      .primaryKey()
      .references(() => servers.id, { onDelete: "cascade" }),
    clusterId: text("cluster_id")
      .notNull()
      .references(() => clusters.id, { onDelete: "cascade" }),
    joinedAt: isoTimestamptz("joined_at").notNull(),
    // Set while the member is being removed; no new work is placed on it.
    emptyingSince: isoTimestamptz("emptying_since"),
    // Why emptying stopped, until an admin continues; empty while it runs.
    emptyingError: text("emptying_error").notNull().default(""),
    // The workload moving now: its id, and "app" or "database". Empty between two moves.
    emptyingWorkload: text("emptying_workload").notNull().default(""),
    emptyingWorkloadKind: text("emptying_workload_kind").notNull().default(""),
    emptyingTotal: integer("emptying_total").notNull().default(0),
    // The team whose Activity carries what Deplo says about this emptying.
    emptyingTeamId: text("emptying_team_id").references(() => teams.id, {
      onDelete: "set null",
    }),
    // What the leader last said about this member's lease: ok, not_responding or fenced.
    leaseState: text("lease_state").notNull().default("ok"),
    leaseChangedAt: isoTimestamptz("lease_changed_at"),
    // Null until the cluster's leader first answers for this member: it reads Provisioning until then.
    readyAt: isoTimestamptz("ready_at"),
  },
  (t) => [index("cluster_members_cluster_idx").on(t.clusterId)],
);

// Which member holds which release image of a cluster App, and how far a copy has got (spec #176).
export const clusterImageCopies = pgTable(
  "cluster_image_copies",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    imageRef: text("image_ref").notNull(),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    // "copying" | "held" | "failed"
    state: text("state").notNull(),
    error: text("error").notNull().default(""),
    createdAt: isoTimestamptz("created_at").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.imageRef, t.serverId] }),
    index("cluster_image_copies_server_idx").on(t.serverId),
  ],
);

// The architectures a pulled image is published for, as its registry listed them. No row means not known.
export const imageArchitectures = pgTable(
  "image_architectures",
  {
    imageRef: text("image_ref").notNull(),
    arch: text("arch").notNull(),
    checkedAt: isoTimestamptz("checked_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.imageRef, t.arch] })],
);

// The leader's placement, mirrored; only the placement module writes it. A null member is waiting for room.
export const workloadPlacements = pgTable(
  "workload_placements",
  {
    kind: text("kind").notNull(),
    workloadId: text("workload_id").notNull(),
    replica: integer("replica").notNull().default(0),
    memberServerId: text("member_server_id").references(() => servers.id, {
      onDelete: "set null",
    }),
    epoch: integer("epoch").notNull().default(0),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.workloadId, t.replica] }),
    index("workload_placements_member_idx").on(t.memberServerId),
  ],
);

// One row per server whose cluster binary update is failing; none means idle. See docs/agents/cluster-rollout.md.
export const clusterBinaryUpdates = pgTable("cluster_binary_updates", {
  serverId: text("server_id")
    .primaryKey()
    .references(() => servers.id, { onDelete: "cascade" }),
  targetVersion: text("target_version").notNull(),
  // "busy" | "error" | "no_return"
  failure: text("failure").notNull(),
  attempts: integer("attempts").notNull().default(0),
  firstFailedAt: isoTimestamptz("first_failed_at").notNull(),
  nextRetryAt: isoTimestamptz("next_retry_at").notNull(),
  lastError: text("last_error").notNull().default(""),
  updatedAt: isoTimestamptz("updated_at").notNull(),
});

// How replication of one App stands on one member, as its server agent last said (ADR-0046). Read back every pass.
export const clusterAppReplicas = pgTable(
  "cluster_app_replicas",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    // "sending" | "receiving" | "idle"
    role: text("role").notNull(),
    connected: boolean("connected").notNull().default(false),
    // The member's copy once held all of the App's data: a failover may put it in place.
    synced: boolean("synced").notNull().default(false),
    appliedAt: isoTimestamptz("applied_at"),
    bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
    error: text("error").notNull().default(""),
    checkedAt: isoTimestamptz("checked_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.serverId] }),
    index("cluster_app_replicas_server_idx").on(t.serverId),
  ],
);

// Load balancing to the most available member: the one member whose connector takes an App's visitors.
export const clusterEntrances = pgTable("cluster_entrances", {
  appId: text("app_id")
    .primaryKey()
    .references(() => apps.id, { onDelete: "cascade" }),
  serverId: text("server_id")
    .notNull()
    .references(() => servers.id, { onDelete: "cascade" }),
  chosenAt: isoTimestamptz("chosen_at").notNull(),
});

// Each server's end of its cluster's network (ADR-0047): the WireGuard key and UDP port its agent answered with.
// No foreign key to the cluster: a deleted cluster's rows are how the sweep finds the servers to take off it.
export const clusterNetworkPeers = pgTable(
  "cluster_network_peers",
  {
    clusterId: text("cluster_id").notNull(),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    publicKey: text("public_key").notNull(),
    port: integer("port").notNull().default(0),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.clusterId, t.serverId] }),
    index("cluster_network_peers_server_idx").on(t.serverId),
  ],
);

// A DNS zone delegated to a cluster (ADR-0049): its servers answer for it. A zone belongs to one cluster.
export const clusterDnsZones = pgTable(
  "cluster_dns_zones",
  {
    id: text("id").primaryKey(),
    clusterId: text("cluster_id")
      .notNull()
      .references(() => clusters.id, { onDelete: "cascade" }),
    // Lower case, no trailing dot: "go.example.com".
    name: text("name").notNull(),
    // The connected Cloudflare zone above it, where Deplo keeps its NS and glue; null when a person types them.
    providerId: text("provider_id").references(() => dnsProviders.id, {
      onDelete: "set null",
    }),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("cluster_dns_zones_name_uq").on(t.name),
    index("cluster_dns_zones_cluster_idx").on(t.clusterId),
  ],
);

// ns1 to ns4 of every zone of a cluster: kept as chosen, so the records at the registrar stay right.
export const clusterNameServers = pgTable(
  "cluster_name_servers",
  {
    clusterId: text("cluster_id")
      .notNull()
      .references(() => clusters.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
  },
  // No unique key on the server: a Deplo move may place two old servers on one, and the choice is redone each pass.
  (t) => [primaryKey({ columns: [t.clusterId, t.position] })],
);

// A zone's own certificate (ADR-0049 phase 3): ordered once, renewed by one server of the cluster, held by the rest.
export const clusterZoneCerts = pgTable("cluster_zone_certs", {
  zoneId: text("zone_id")
    .primaryKey()
    .references(() => clusterDnsZones.id, { onDelete: "cascade" }),
  renewerServerId: text("renewer_server_id").references(() => servers.id, {
    onDelete: "set null",
  }),
  // When the renewer was first found unreachable: past a while another server takes it over.
  renewerLostAt: isoTimestamptz("renewer_lost_at"),
  certPem: text("cert_pem"),
  keyEnc: text("key_enc"),
  sha256: text("sha256"),
  notAfter: isoTimestamptz("not_after"),
  issuedAt: isoTimestamptz("issued_at"),
  renewedAt: isoTimestamptz("renewed_at"),
  // The renewer's proxy's last failed order, as it said it.
  error: text("error").notNull().default(""),
  errorAt: isoTimestamptz("error_at"),
  ordering: boolean("ordering").notNull().default(false),
});

// A name's own certificate over DNS, renewed by one server and held by every other (ADR-0048 step 5, #228).
export const clusterNameCerts = pgTable(
  "cluster_name_certs",
  {
    zoneId: text("zone_id")
      .notNull()
      .references(() => clusterDnsZones.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    renewerServerId: text("renewer_server_id").references(() => servers.id, {
      onDelete: "set null",
    }),
    renewerLostAt: isoTimestamptz("renewer_lost_at"),
    certPem: text("cert_pem"),
    keyEnc: text("key_enc"),
    sha256: text("sha256"),
    notAfter: isoTimestamptz("not_after"),
    issuedAt: isoTimestamptz("issued_at"),
    renewedAt: isoTimestamptz("renewed_at"),
    error: text("error").notNull().default(""),
    errorAt: isoTimestamptz("error_at"),
    ordering: boolean("ordering").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.zoneId, t.name] })],
);

// How each server answers for its cluster's zone, as its agent last said. No foreign key to the cluster: a deleted
// cluster's rows are how the sweep finds the servers to stop.
export const clusterZoneStates = pgTable(
  "cluster_zone_states",
  {
    clusterId: text("cluster_id").notNull(),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    // Port 53 open on at least one of its addresses.
    serving: boolean("serving").notNull().default(false),
    problem: text("problem").notNull().default(""),
    // "answer" | "stale" | "fail" | "warming" | "unsupported" | "unreachable"
    state: text("state").notNull(),
    heard: integer("heard").notNull().default(0),
    // The location table its name server places visitors with, by digest; "" for none (ADR-0049 phase 2).
    geoSha256: text("geo_sha256").notNull().default(""),
    checkedAt: isoTimestamptz("checked_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.clusterId, t.serverId] })],
);

// How one server of a cluster reaches another through the network, as its agent last said.
export const clusterNetworkLinks = pgTable(
  "cluster_network_links",
  {
    clusterId: text("cluster_id").notNull(),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    peerServerId: text("peer_server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    // "direct" | "relay" | "none"
    path: text("path").notNull(),
    checkedAt: isoTimestamptz("checked_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.clusterId, t.serverId, t.peerServerId] })],
);

// A server added from inside a cluster: it joins once it is installed and answers.
export const clusterJoinRequests = pgTable("cluster_join_requests", {
  serverId: text("server_id")
    .primaryKey()
    .references(() => servers.id, { onDelete: "cascade" }),
  clusterId: text("cluster_id")
    .notNull()
    .references(() => clusters.id, { onDelete: "cascade" }),
  // Who asked, and where: the join runs as them, so every check of a join holds.
  requestedByUserId: text("requested_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  requestedByTeamId: text("requested_by_team_id").references(() => teams.id, {
    onDelete: "set null",
  }),
  // Why the last try did not join; empty while nothing was refused.
  error: text("error").notNull().default(""),
  triedAt: isoTimestamptz("tried_at"),
  requestedAt: isoTimestamptz("requested_at").notNull(),
});
