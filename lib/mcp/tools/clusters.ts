import * as z from "zod";
import { tool, type McpToolDef } from "./tool-def";

const CLUSTER_FIELDS = /* GraphQL */ `
  id
  name
  allTeams
  failoverEnabled
  replicationEnabled
  loadBalancingEnabled
  loadBalancingMode
  answerMaxConnections
  answerMaxWaiting
  leaderEpoch
  createdAt
`;

export const CLUSTERS: McpToolDef[] = [
  tool({
    name: "list_clusters",
    title: "List clusters",
    description:
      "The clusters (several servers that act as one) this team may use.",
    group: "Servers",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpListClusters { clusters { ${CLUSTER_FIELDS} } }
    `,
  }),
  tool({
    name: "get_cluster",
    title: "Get a cluster",
    description:
      "One cluster: who may use it, its servers with status, leaseState, network and relay warning, place in the line of succession, joins and removals, failover, replication, load balancing, data copies, waiting Apps.",
    group: "Servers",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({
      id: z
        .string()
        .describe("The cluster's id, as returned by list_clusters."),
    }),
    query: /* GraphQL */ `
      query McpGetCluster($id: String!) {
        cluster(id: $id) {
          ${CLUSTER_FIELDS}
          failoverOn
          waiting
          replication { appId appName following held total upToDateAt error }
          imageCopies { appId appName held total }
          members {
            serverId serverName status leaseState provisioning joinedAt emptyingSince
            emptying { total left moving error }
            network { relayed unreachable }
            relayWarning
            copyWarning
            nextInLine
          }
          teams { id name slug }
        }
      }
    `,
  }),
  tool({
    name: "set_cluster_replication",
    title: "Turn a cluster's replication on or off",
    description:
      "On, the cluster's Apps stream their stored data to its other servers as it changes, and its databases keep a standby copy: the only way an App with stored data fails over. Off undoes both.",
    group: "Servers",
    requires: "instanceAdmin",
    idempotent: true,
    input: z.object({
      id: z
        .string()
        .describe("The cluster's id, as returned by list_clusters."),
      enabled: z.boolean(),
    }),
    query: /* GraphQL */ `
      mutation McpSetClusterReplication($id: String!, $enabled: Boolean!) {
        setClusterReplication(id: $id, enabled: $enabled) {
          ${CLUSTER_FIELDS}
        }
      }
    `,
  }),
  tool({
    name: "set_cluster_load_balancing",
    title: "Turn a cluster's load balancing on or off",
    description:
      "Needs replication on. Apps that keep no data and every server reaches (Cloudflare, or certificates every server holds) run on all of them from their next deploy; visitors go to the `nearest` or `most_available` one.",
    group: "Servers",
    requires: "instanceAdmin",
    idempotent: true,
    input: z.object({
      id: z
        .string()
        .describe("The cluster's id, as returned by list_clusters."),
      enabled: z.boolean(),
      mode: z.enum(["nearest", "most_available"]).optional(),
    }),
    query: /* GraphQL */ `
      mutation McpSetClusterLoadBalancing(
        $id: String!
        $enabled: Boolean!
        $mode: ClusterLoadBalancingMode
      ) {
        setClusterLoadBalancing(id: $id, enabled: $enabled, mode: $mode) {
          ${CLUSTER_FIELDS}
        }
      }
    `,
  }),
  tool({
    name: "set_cluster_answer_limits",
    title:
      "Set a cluster's connection limits for domains that answer on every server",
    description:
      "Per server: visitor connections it carries at once for domains that answer on every server (64-65536, up to 64 KB of memory each, a quarter of the smallest server's at most), and how many wait per App.",
    group: "Servers",
    requires: "instanceAdmin",
    idempotent: true,
    input: z.object({
      id: z
        .string()
        .describe("The cluster's id, as returned by list_clusters."),
      maxConnections: z.number().int().min(64).max(65536),
      maxWaiting: z.number().int().min(1),
    }),
    query: /* GraphQL */ `
      mutation McpSetClusterAnswerLimits(
        $id: String!
        $maxConnections: Int!
        $maxWaiting: Int!
      ) {
        setClusterAnswerLimits(
          id: $id
          maxConnections: $maxConnections
          maxWaiting: $maxWaiting
        ) {
          ${CLUSTER_FIELDS}
        }
      }
    `,
  }),
];
