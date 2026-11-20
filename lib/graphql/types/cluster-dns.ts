import { builder } from "../builder";
import {
  addClusterDnsZone,
  appDnsZones,
  checkClusterDnsZone,
  clusterDnsView,
  placeClusterServer,
  removeClusterDnsZone,
  setClusterDnsTimes,
  setDomainDnsZone,
} from "@/lib/data/clusters/dns-zone";
import { findCities } from "@/lib/data/clusters/server-place";
import {
  checkDomainAcmeCname,
  setClusterDnsWildcard,
} from "@/lib/data/clusters/zone-certs";
import type { CityMatch } from "@/lib/geo/cities";
import type {
  ClusterDnsView,
  ClusterDnsZoneView,
  ClusterGeoTable,
  ClusterServerPlace,
  ClusterZoneServerState,
  DelegationCheck,
  ZoneCertificateView,
} from "@/lib/types/cluster-dns";
import type { DelegationRecord } from "@/lib/deploy/cluster-zone";

// A cluster's own DNS zone (ADR-0049): https://deplo.build/docs/operations/clusters/dns-zone

const DelegationRecordRef = builder
  .objectRef<DelegationRecord>("DnsDelegationRecord")
  .implement({
    description:
      "A record to add where the domain was bought, so a zone is delegated to its cluster.",
    fields: (t) => ({
      name: t.exposeString("name"),
      type: t.exposeString("type", { description: "NS, A or AAAA." }),
      value: t.exposeString("value"),
    }),
  });

const ZoneCertificateRenewerRef = builder
  .objectRef<NonNullable<ZoneCertificateView["renewer"]>>(
    "ZoneCertificateRenewer",
  )
  .implement({
    fields: (t) => ({
      serverId: t.exposeString("serverId"),
      serverName: t.exposeString("serverName"),
    }),
  });

const ZoneCertificateRef = builder
  .objectRef<ZoneCertificateView>("ZoneCertificate")
  .implement({
    description:
      "A zone's own certificate: ordered once over DNS, renewed by one server of the cluster, held by every other.",
    fields: (t) => ({
      names: t.exposeStringList("names", {
        description:
          "The names on it: the zone and every name one label below.",
      }),
      serves: t.exposeStringList("serves", {
        description: "The domains it serves now.",
      }),
      validUntil: t.exposeString("validUntil", { nullable: true }),
      valid: t.exposeBoolean("valid", { description: "It has not expired." }),
      issuedAt: t.exposeString("issuedAt", { nullable: true }),
      renewedAt: t.exposeString("renewedAt", { nullable: true }),
      renewer: t.field({
        type: ZoneCertificateRenewerRef,
        nullable: true,
        description: "The one server that orders and renews it.",
        resolve: (c) => c.renewer,
      }),
      ordering: t.exposeBoolean("ordering", {
        description: "The renewing server is asking for it now.",
      }),
      error: t.exposeString("error", {
        description:
          "Why the last order failed, in plain words; empty when it did not.",
      }),
      errorDetail: t.exposeString("errorDetail", {
        description: "The same failure as the certificate authority said it.",
      }),
      errorAt: t.exposeString("errorAt", { nullable: true }),
    }),
  });

const ClusterDnsZoneRef = builder
  .objectRef<ClusterDnsZoneView>("ClusterDnsZone")
  .implement({
    description:
      "A DNS zone delegated to a cluster: its servers answer for it, naming the healthy ones.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      records: t.field({
        type: [DelegationRecordRef],
        description:
          "The NS records and their addresses (the glue) to add where the domain was bought.",
        resolve: (z) => z.records,
      }),
      names: t.exposeStringList("names", {
        description:
          "The names it answers: each domain answered by it, as its name in the zone.",
      }),
      certificate: t.field({
        type: ZoneCertificateRef,
        resolve: (z) => z.certificate,
      }),
    }),
  });

const ClusterZoneServerRef = builder
  .objectRef<ClusterZoneServerState>("ClusterZoneServer")
  .implement({
    description:
      "How one server of a cluster answers for its zone, as its agent last said.",
    fields: (t) => ({
      serverId: t.exposeID("serverId"),
      serverName: t.exposeString("serverName"),
      serving: t.exposeBoolean("serving", {
        description: "Port 53 is open on at least one of its addresses.",
      }),
      problem: t.exposeString("problem"),
      state: t.exposeString("state", {
        description:
          "answer, stale (hears exactly half: the last agreed set), fail (hears fewer than half: SERVFAIL), warming, unsupported (agent too old) or unreachable.",
      }),
      heard: t.exposeInt("heard", {
        description:
          "How many servers of the cluster it hears, itself included.",
      }),
      checkedAt: t.exposeString("checkedAt"),
      nearest: t.exposeBoolean("nearest", {
        description:
          "It answers each visitor with the servers nearest it: it holds the release's location table and every server has a place.",
      }),
    }),
  });

type Place = NonNullable<ClusterServerPlace["place"]>;

const ServerPlaceRef = builder.objectRef<Place>("ServerPlace").implement({
  description:
    "Where a server is, for a cluster's DNS zone to answer each visitor with the nearest servers.",
  fields: (t) => ({
    latitude: t.exposeFloat("latitude"),
    longitude: t.exposeFloat("longitude"),
    label: t.exposeString("label", {
      description: "The city, or the coordinates.",
    }),
    source: t.exposeString("source", {
      description:
        "city or coordinates when an instance admin set it, address when Deplo placed the server by its own address.",
    }),
  }),
});

const ClusterServerPlaceRef = builder
  .objectRef<ClusterServerPlace>("ClusterServerPlace")
  .implement({
    fields: (t) => ({
      serverId: t.exposeID("serverId"),
      serverName: t.exposeString("serverName"),
      place: t.field({
        type: ServerPlaceRef,
        nullable: true,
        description:
          "Null when nothing places it: no city set, and its address has no place in the table.",
        resolve: (p) => p.place,
      }),
    }),
  });

const ClusterGeoTableRef = builder
  .objectRef<ClusterGeoTable>("ClusterGeoTable")
  .implement({
    description:
      "The location table this release of Deplo carries: IP geolocation by DB-IP (https://db-ip.com), CC BY 4.0.",
    fields: (t) => ({
      state: t.exposeString("state", {
        description: "ready, missing (this build carries none) or damaged.",
      }),
      release: t.exposeString("release", {
        nullable: true,
        description: "DB-IP's release it was built from, as 2026-11.",
      }),
      stale: t.exposeBoolean("stale", {
        description:
          "Older than three months: updating Deplo brings a newer one.",
      }),
      reusedFrom: t.exposeString("reusedFrom", {
        nullable: true,
        description:
          "The Deplo release whose copy this one carries, when DB-IP's download failed as it was built.",
      }),
      problem: t.exposeString("problem"),
    }),
  });

const CityRef = builder.objectRef<CityMatch>("City").implement({
  description: "A city of the release's location table, to place a server in.",
  fields: (t) => ({
    name: t.exposeString("name"),
    region: t.exposeString("region"),
    country: t.exposeString("country", { description: "ISO 3166 code." }),
    label: t.exposeString("label"),
    latitude: t.exposeFloat("latitude"),
    longitude: t.exposeFloat("longitude"),
  }),
});

const ClusterNameServerRef = builder
  .objectRef<ClusterDnsView["nameServers"][number]>("ClusterNameServer")
  .implement({
    fields: (t) => ({
      position: t.exposeInt("position", {
        description: "1 for ns1, and so on.",
      }),
      serverId: t.exposeID("serverId"),
      serverName: t.exposeString("serverName"),
    }),
  });

const ClusterDnsRef = builder
  .objectRef<ClusterDnsView>("ClusterDns")
  .implement({
    fields: (t) => ({
      zones: t.field({ type: [ClusterDnsZoneRef], resolve: (v) => v.zones }),
      nameServers: t.field({
        type: [ClusterNameServerRef],
        resolve: (v) => v.nameServers,
      }),
      servers: t.field({
        type: [ClusterZoneServerRef],
        resolve: (v) => v.servers,
      }),
      places: t.field({
        type: [ClusterServerPlaceRef],
        description: "Where each server of the cluster is.",
        resolve: (v) => v.places,
      }),
      geo: t.field({ type: ClusterGeoTableRef, resolve: (v) => v.geo }),
      answerTtl: t.exposeInt("answerTtl", {
        description: "Seconds a resolver keeps an answer (10 to 300).",
      }),
      dropAfter: t.exposeInt("dropAfter", {
        description:
          "Seconds a server unheard on the private network stays in the answers (5 to 60).",
      }),
      wildcard: t.exposeBoolean("wildcard", {
        description:
          "Each zone has one certificate for every name one label below it; off, each name gets its own over DNS.",
      }),
    }),
  });

const DelegationCheckServerRef = builder
  .objectRef<DelegationCheck["nameServers"][number]>("DnsDelegationNameServer")
  .implement({
    fields: (t) => ({
      name: t.exposeString("name"),
      address: t.exposeString("address"),
      answers: t.exposeBoolean("answers", {
        description: "It answered for the zone, asked from Deplo.",
      }),
    }),
  });

const DelegationCheckRef = builder
  .objectRef<DelegationCheck>("DnsDelegationCheck")
  .implement({
    fields: (t) => ({
      delegated: t.exposeBoolean("delegated"),
      parent: t.exposeString("parent", { nullable: true }),
      problems: t.exposeStringList("problems", {
        description: "What to fix, one record each.",
      }),
      nameServers: t.field({
        type: [DelegationCheckServerRef],
        resolve: (c) => c.nameServers,
      }),
    }),
  });

const AppDnsZoneRef = builder
  .objectRef<{ id: string; name: string }>("AppDnsZone")
  .implement({
    fields: (t) => ({ id: t.exposeID("id"), name: t.exposeString("name") }),
  });

builder.queryFields((t) => ({
  clusterDns: t.field({
    type: ClusterDnsRef,
    authScopes: { instanceAdmin: true },
    description:
      "A cluster's DNS zones, the records to add for them, its name servers and how each server answers.",
    args: { clusterId: t.arg.string({ required: true }) },
    resolve: (_r, { clusterId }) => clusterDnsView(clusterId),
  }),
  checkClusterDnsZone: t.field({
    type: DelegationCheckRef,
    authScopes: { instanceAdmin: true },
    description:
      "Asks the zone's parent whether it is delegated to the cluster (its NS records and their addresses, no DS record), and each name server whether it answers.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => checkClusterDnsZone(id),
  }),
  searchCities: t.field({
    type: [CityRef],
    authScopes: { instanceAdmin: true },
    description:
      "Cities of the release's location table whose name, region or country hold every word typed, biggest first.",
    args: { query: t.arg.string({ required: true }) },
    resolve: (_r, { query }) => findCities(query),
  }),
  appDnsZones: t.field({
    type: [AppDnsZoneRef],
    authScopes: { loggedIn: true },
    description:
      "The DNS zones of an App's cluster, which its domains that answer on every server can point at.",
    args: { appId: t.arg.string({ required: true }) },
    resolve: (_r, { appId }) => appDnsZones(appId),
  }),
}));

builder.mutationFields((t) => ({
  addClusterDnsZone: t.string({
    authScopes: { instanceAdmin: true },
    description:
      "Lets a cluster's servers answer for a DNS zone (go.example.com), once it is delegated to them where the domain was bought. Returns the zone's id.",
    args: {
      clusterId: t.arg.string({ required: true }),
      name: t.arg.string({ required: true }),
    },
    resolve: (_r, { clusterId, name }) => addClusterDnsZone(clusterId, name),
  }),
  removeClusterDnsZone: t.string({
    authScopes: { instanceAdmin: true },
    description:
      "Stops a cluster answering for a DNS zone. Returns the cluster's id.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => removeClusterDnsZone(id),
  }),
  setClusterDnsTimes: t.boolean({
    authScopes: { instanceAdmin: true },
    description:
      "How long resolvers keep the cluster's DNS answers (10 to 300 s, default 30), and how long a server unheard on the private network stays in them (5 to 60 s, default 10).",
    args: {
      clusterId: t.arg.string({ required: true }),
      answerTtl: t.arg.int({ required: true }),
      dropAfter: t.arg.int({ required: true }),
    },
    resolve: async (_r, { clusterId, answerTtl, dropAfter }) => {
      await setClusterDnsTimes(clusterId, answerTtl, dropAfter);
      return true;
    },
  }),
  setClusterDnsWildcard: t.boolean({
    authScopes: { instanceAdmin: true },
    description:
      "On (the default), each of the cluster's zones gets one certificate for itself and every name one label below it. Off, each name gets a certificate of its own over DNS.",
    args: {
      clusterId: t.arg.string({ required: true }),
      on: t.arg.boolean({ required: true }),
    },
    resolve: async (_r, { clusterId, on }) => {
      await setClusterDnsWildcard(clusterId, on);
      return true;
    },
  }),
  checkDomainAcmeCname: t.boolean({
    authScopes: { capability: "manage_domains" },
    unauthorizedError: () =>
      "You can’t change this domain with your current team role. Ask a team admin for the Manage domains capability.",
    description:
      "Looks up the domain's _acme-challenge CNAME into its cluster's zone now. Once it is seen, the domain's certificate is checked over DNS from the zone. Returns whether it was seen.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => checkDomainAcmeCname(id),
  }),
  setServerPlace: t.boolean({
    authScopes: { instanceAdmin: true },
    description:
      "Places a server for its cluster's DNS zone: a city (label and its position) or bare coordinates. Without coordinates, Deplo places it by its own address again.",
    args: {
      serverId: t.arg.string({ required: true }),
      latitude: t.arg.float({ required: false }),
      longitude: t.arg.float({ required: false }),
      label: t.arg.string({ required: false }),
    },
    resolve: async (_r, { serverId, latitude, longitude, label }) => {
      if ((latitude == null) !== (longitude == null))
        throw new Error("A place needs both a latitude and a longitude.");
      await placeClusterServer(
        serverId,
        latitude != null && longitude != null
          ? { latitude, longitude, label }
          : null,
      );
      return true;
    },
  }),
  setDomainDnsZone: t.string({
    authScopes: { capability: "manage_domains" },
    unauthorizedError: () =>
      "You can’t change this domain with your current team role. Ask a team admin for the Manage domains capability.",
    description:
      "Lets the App's cluster answer for a domain that answers on every server, through one of the cluster's DNS zones; null goes back to records written elsewhere. A domain outside the zone then needs one CNAME into it. Returns the App's id.",
    args: {
      id: t.arg.string({ required: true }),
      zoneId: t.arg.string({ required: false }),
    },
    resolve: (_r, { id, zoneId }) => setDomainDnsZone(id, zoneId ?? null),
  }),
}));
