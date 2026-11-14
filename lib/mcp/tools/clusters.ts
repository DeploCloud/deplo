import * as z from "zod";
import { tool, type McpToolDef } from "./tool-def";

const CLUSTER_FIELDS = /* GraphQL */ `
  id
  name
  allTeams
  failoverEnabled
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
      "One cluster: the teams that may use it, its servers with status, leaseState, whether one is still joining and how far a removal has got, whether failover is on, and the Apps waiting for room after a server stopped.",
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
          members {
            serverId serverName status leaseState provisioning joinedAt emptyingSince
            emptying { total left moving error }
          }
          teams { id name slug }
        }
      }
    `,
  }),
];
