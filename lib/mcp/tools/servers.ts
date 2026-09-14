import * as z from "zod";
import { serverId, tool, type McpToolDef } from "./tool-def";

const SERVER_FIELDS = /* GraphQL */ `
  id
  name
  host
  ip
  status
  statusMessage
  role
  agentVersion
  expectedAgentVersion
  cpuCores
  memoryMb
  diskGb
  isDeploHost
  provisioned
  lastSeenAt
`;

export const SERVERS: McpToolDef[] = [
  tool({
    name: "list_servers",
    title: "List servers",
    description:
      "Every server in the fleet with its agent version and last-seen time.",
    group: "Servers",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpListServers { servers { ${SERVER_FIELDS} } }
    `,
  }),
  tool({
    name: "get_server",
    title: "Get a server",
    description: "One server in full, including which teams may deploy to it.",
    group: "Servers",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({ id: serverId }),
    query: /* GraphQL */ `
      query McpGetServer($id: String!) {
        server(id: $id) {
          ${SERVER_FIELDS}
          dockerVersion hostArch deployConcurrency traefikEnabled allTeams
          teams { id name slug }
        }
      }
    `,
  }),
  tool({
    name: "check_server_health",
    title: "Check a server's health",
    description: "Probe the server's agent right now and record the result.",
    group: "Servers",
    requires: "instanceAdmin",
    idempotent: true,
    input: z.object({ id: serverId }),
    query: /* GraphQL */ `
      mutation McpCheckServerHealth($id: String!) {
        checkServerHealth(id: $id, force: true) { ${SERVER_FIELDS} }
      }
    `,
  }),
  tool({
    name: "check_server_readiness",
    title: "Check whether a server can deploy",
    description:
      "A per-check report on whether this server can run a deployment right now: Docker, Traefik, ports, disk, build tools.",
    group: "Servers",
    requires: "instanceAdmin",
    readOnly: true,
    idempotent: true,
    input: z.object({ id: serverId }),
    query: /* GraphQL */ `
      mutation McpCheckServerReadiness($id: String!) {
        checkServerReadiness(id: $id) {
          serverId
          serverName
          verdict
          summary
          checkedAt
          checks {
            id
            label
            group
            severity
            detail
            hint
          }
        }
      }
    `,
  }),
  tool({
    name: "update_server_agent",
    title: "Update a server's agent",
    description:
      "Update the Deplo agent binary on one host in place. Agent releases are forward-only: this cannot be undone.",
    group: "Servers",
    requires: "instanceAdmin",
    destructive: true,
    input: z.object({ id: serverId }),
    query: /* GraphQL */ `
      mutation McpUpdateServerAgent($id: String!) {
        updateServerAgent(id: $id)
      }
    `,
  }),
  tool({
    name: "restart_server_workloads",
    title: "Restart everything on a server",
    description:
      "Restart every app and database running on one host. Every workload on it stops serving briefly.",
    group: "Servers",
    requires: "instanceAdmin",
    destructive: true,
    input: z.object({ id: serverId }),
    query: /* GraphQL */ `
      mutation McpRestartServerWorkloads($id: String!) {
        restartServerWorkloads(id: $id) {
          restarted
          skipped
          failures {
            kind
            name
            error
          }
        }
      }
    `,
  }),
  tool({
    name: "restart_server_traefik",
    title: "Restart a server's proxy",
    description:
      "Restart Traefik on one host. Every domain it serves is briefly unreachable.",
    group: "Servers",
    requires: "instanceAdmin",
    destructive: true,
    input: z.object({ id: serverId }),
    query: /* GraphQL */ `
      mutation McpRestartServerTraefik($id: String!) {
        restartServerTraefik(id: $id)
      }
    `,
  }),
  tool({
    name: "run_docker_cleanup",
    title: "Reclaim disk on a server",
    description:
      "Run the Docker cleanup sweep on one host now. Never prunes volumes or system-wide.",
    group: "Servers",
    requires: "instanceAdmin",
    input: z.object({ serverId }),
    query: /* GraphQL */ `
      mutation McpRunDockerCleanup($serverId: String!) {
        runDockerCleanupNow(serverId: $serverId) {
          id
          serverId
          status
          startedAt
          finishedAt
          reclaimedBytes
          error
        }
      }
    `,
  }),
];
