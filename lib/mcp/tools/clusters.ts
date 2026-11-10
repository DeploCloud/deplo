import * as z from "zod";
import { tool, type McpToolDef } from "./tool-def";

const CLUSTER_FIELDS = /* GraphQL */ `
  id
  name
  allTeams
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
    description: "One cluster in full, including which teams may use it.",
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
        cluster(id: $id) { ${CLUSTER_FIELDS} teams { id name slug } }
      }
    `,
  }),
];
