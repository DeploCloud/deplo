import { builder } from "../builder";
import {
  addClusterDnsZone,
  appDnsZones,
  checkClusterDnsZone,
  clusterDnsView,
  removeClusterDnsZone,
  setClusterDnsTimes,
  setDomainDnsZone,
} from "@/lib/data/clusters/dns-zone";
import type {
  ClusterDnsView,
  ClusterDnsZoneView,
  ClusterZoneServerState,
  DelegationCheck,
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
      answerTtl: t.exposeInt("answerTtl", {
        description: "Seconds a resolver keeps an answer (10 to 300).",
      }),
      dropAfter: t.exposeInt("dropAfter", {
        description:
          "Seconds a server unheard on the private network stays in the answers (5 to 60).",
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
