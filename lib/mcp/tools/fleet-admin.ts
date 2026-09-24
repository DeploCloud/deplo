import * as z from "zod";
import { serverId, tool, type McpToolDef } from "./tool-def";

const SERVER_ROW = /* GraphQL */ `
  id
  name
  host
  role
  type
  status
  allTeams
  buildFallback
  deployConcurrency
  agentVersion
  isDeploHost
`;

export const FLEET: McpToolDef[] = [
  tool({
    name: "add_server",
    title: "Register a new server",
    description:
      "Add a machine to the fleet. Returns the one-line install command that has to be run on it once; it carries an enrolment token, so hand it to the person who owns the machine rather than repeating it.",
    group: "Servers",
    requires: "instanceAdmin",
    input: z.object({
      name: z.string(),
      host: z.string().describe("IP or hostname Deplo dials."),
      allTeams: z.boolean().optional().describe("Usable by every team."),
      teamIds: z.array(z.string()).optional(),
      buildOnly: z.boolean().optional(),
      storageOnly: z.boolean().optional(),
    }),
    variables: (a) => ({ input: a }),
    query: /* GraphQL */ `
      mutation McpAddServer($input: AddServerInput!) {
        addServer(input: $input) {
          server { ${SERVER_ROW} }
          installCommand
        }
      }
    `,
  }),
  tool({
    name: "remove_server",
    title: "Remove a server",
    description:
      "Take a server out of the fleet. Refused while apps still run on it; the agent is uninstalled by the reaper afterwards.",
    group: "Servers",
    requires: "instanceAdmin",
    destructive: true,
    input: z.object({ serverId }),
    variables: (a) => ({ id: a.serverId }),
    query: /* GraphQL */ `
      mutation McpRemoveServer($id: String!) {
        removeServer(id: $id) {
          warning
        }
      }
    `,
  }),
  tool({
    name: "update_server",
    title: "Change a server's address, role, teams or limits",
    description:
      "Any of: the address Deplo dials, its role, which teams may use it, build fallback, deploy concurrency, timezone, canary agent releases.",
    group: "Servers",
    requires: "instanceAdmin",
    idempotent: true,
    input: z.object({
      serverId,
      address: z.string().optional(),
      agentPort: z.number().int().optional(),
      role: z.string().optional(),
      allTeams: z.boolean().optional(),
      teamIds: z.array(z.string()).optional(),
      buildFallback: z.boolean().optional(),
      deployConcurrency: z.number().int().optional(),
      timezone: z.string().optional().describe("IANA zone."),
      agentCanary: z
        .boolean()
        .optional()
        .describe("Offer canary agent versions as updates."),
    }),
    variables: (a) => ({
      id: a.serverId,
      address: a.address ?? "",
      agentPort: a.agentPort,
      role: a.role ?? "",
      teams: {
        serverId: a.serverId,
        allTeams: a.allTeams ?? false,
        teamIds: a.teamIds,
      },
      buildFallback: a.buildFallback,
      concurrency: a.deployConcurrency ?? 1,
      timezone: a.timezone ?? "",
      agentCanary: a.agentCanary ?? false,
      setAddress: a.address !== undefined,
      setRole: a.role !== undefined,
      setTeams: a.allTeams !== undefined || a.teamIds !== undefined,
      setFallback: a.buildFallback !== undefined,
      setConcurrency: a.deployConcurrency !== undefined,
      setTimezone: a.timezone !== undefined,
      setCanary: a.agentCanary !== undefined,
    }),
    query: /* GraphQL */ `
      mutation McpUpdateServer(
        $id: String!
        $address: String!
        $agentPort: Int
        $role: String!
        $teams: SetServerTeamsInput!
        $buildFallback: Boolean
        $concurrency: Int!
        $timezone: String!
        $agentCanary: Boolean!
        $setAddress: Boolean!
        $setRole: Boolean!
        $setTeams: Boolean!
        $setFallback: Boolean!
        $setConcurrency: Boolean!
        $setTimezone: Boolean!
        $setCanary: Boolean!
      ) {
        updateServerAddress(id: $id, address: $address, agentPort: $agentPort)
          @include(if: $setAddress)
        setServerRole(id: $id, role: $role) @include(if: $setRole) {
          id
          role
        }
        setServerTeams(input: $teams) @include(if: $setTeams) {
          id
          allTeams
        }
        setServerBuildFallback(id: $id, buildFallback: $buildFallback)
          @include(if: $setFallback) {
          id
          buildFallback
        }
        setServerDeployConcurrency(id: $id, concurrency: $concurrency)
          @include(if: $setConcurrency) {
          id
          deployConcurrency
        }
        setServerTimezone(id: $id, timezone: $timezone)
          @include(if: $setTimezone) {
          timezone
        }
        setServerAgentCanary(id: $id, agentCanary: $agentCanary)
          @include(if: $setCanary) {
          id
          agentCanary
        }
      }
    `,
  }),
  tool({
    name: "get_server_host_info",
    title: "Read a server's host facts",
    description:
      "Ask the server about itself: OS, kernel, CPU, memory, disk, Docker version, timezone and uptime.",
    group: "Servers",
    requires: "instanceAdmin",
    idempotent: true,
    input: z.object({ serverId }),
    variables: (a) => ({ id: a.serverId }),
    query: /* GraphQL */ `
      mutation McpHostInfo($id: String!) {
        checkServerHostInfo(id: $id) {
          osPretty
          kernel
          arch
          cpuModel
          cpuCores
          memTotalBytes
          diskTotalBytes
          diskUsedBytes
          dockerVersion
          timezone
          uptimeSec
        }
      }
    `,
  }),
  tool({
    name: "check_agent_updates",
    title: "Check for server agent updates",
    description:
      "Look up the newest agent release and compare it with what every server runs.",
    group: "Servers",
    requires: "instanceAdmin",
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      mutation McpCheckAgentUpdates {
        checkAgentUpdates
      }
    `,
  }),
  tool({
    name: "uninstall_server_agent",
    title: "Uninstall a server's agent",
    description:
      "Remove the Deplo agent from a machine that has already been taken out of service.",
    group: "Servers",
    requires: "instanceAdmin",
    destructive: true,
    input: z.object({ serverId }),
    variables: (a) => ({ id: a.serverId }),
    query: /* GraphQL */ `
      mutation McpUninstallAgent($id: String!) {
        uninstallServerAgent(id: $id) {
          removed
          warning
          error
        }
      }
    `,
  }),
  tool({
    name: "add_server_certificate",
    title: "Add a custom TLS certificate to a server",
    description:
      "Install your own certificate and key on a server's proxy, for a domain Let's Encrypt cannot issue.",
    group: "Servers",
    requires: "instanceAdmin",
    input: z.object({
      serverId,
      certificate: z.string().describe("PEM chain."),
      privateKey: z.string().describe("PEM key."),
    }),
    variables: (a) => ({
      id: a.serverId,
      input: { certificate: a.certificate, privateKey: a.privateKey },
    }),
    query: /* GraphQL */ `
      mutation McpAddCertificate(
        $id: String!
        $input: ServerCertificateInput!
      ) {
        addServerCertificate(id: $id, input: $input) {
          id
          subject
          domains
          notAfter
          expiresInDays
        }
      }
    `,
  }),
  tool({
    name: "remove_server_certificate",
    title: "Remove a custom TLS certificate",
    description: "Drop a certificate that was added by hand to a server.",
    group: "Servers",
    requires: "instanceAdmin",
    destructive: true,
    input: z.object({ serverId, certificateId: z.string() }),
    variables: (a) => ({ id: a.serverId, certificateId: a.certificateId }),
    query: /* GraphQL */ `
      mutation McpRemoveCertificate($id: String!, $certificateId: String!) {
        removeServerCertificate(id: $id, certificateId: $certificateId) {
          id
          subject
        }
      }
    `,
  }),
  tool({
    name: "set_certificate_email",
    title: "Set the Let's Encrypt account email",
    description:
      "The email every server's certificate account is registered with.",
    group: "Servers",
    requires: "instanceAdmin",
    idempotent: true,
    input: z.object({ email: z.string() }),
    query: /* GraphQL */ `
      mutation McpSetCertificateEmail($email: String!) {
        setCertificateEmail(email: $email) {
          serverName
          email
          unavailable
        }
      }
    `,
  }),
  tool({
    name: "get_docker_cleanup_policy",
    title: "Read the Docker cleanup policy",
    description:
      "Whether automatic cleanup runs, on what schedule, which scopes, and which servers are excluded.",
    group: "Servers",
    requires: "instanceAdmin",
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpCleanupPolicy {
        dockerCleanupPolicy {
          enabled
          schedule
          scopes
          keepImagesPerApp
          minAgeHours
          excludedServerIds
          updatedAt
        }
      }
    `,
  }),
  tool({
    name: "update_docker_cleanup_policy",
    title: "Change the Docker cleanup policy",
    description:
      "Set the whole policy at once: on/off, cron schedule, scopes, images kept per app, minimum age for caches, excluded servers.",
    group: "Servers",
    requires: "instanceAdmin",
    idempotent: true,
    input: z.object({
      enabled: z.boolean(),
      schedule: z.string().describe("5-field cron."),
      scopes: z.array(
        z.enum([
          "unused_app_images",
          "unused_pulled_images",
          "dangling_images",
          "build_cache",
          "orphan_volumes",
          "leftover_networks",
          "leftover_app_files",
        ]),
      ),
      keepImagesPerApp: z.number().int().min(1),
      minAgeHours: z.number().int().min(0),
      excludedServerIds: z.array(z.string()).optional(),
    }),
    variables: (a) => ({ input: a }),
    query: /* GraphQL */ `
      mutation McpUpdateCleanupPolicy($input: UpdateDockerCleanupPolicyInput!) {
        updateDockerCleanupPolicy(input: $input) {
          enabled
          schedule
          scopes
          keepImagesPerApp
          minAgeHours
          excludedServerIds
        }
      }
    `,
  }),
  tool({
    name: "set_server_cleanup_excluded",
    title: "Exclude a server from Docker cleanup",
    description: "Skip (or include again) one server in the cleanup runs.",
    group: "Servers",
    requires: "instanceAdmin",
    idempotent: true,
    input: z.object({ serverId, excluded: z.boolean() }),
    query: /* GraphQL */ `
      mutation McpSetCleanupExcluded($serverId: String!, $excluded: Boolean!) {
        setServerCleanupExcluded(serverId: $serverId, excluded: $excluded) {
          excludedServerIds
        }
      }
    `,
  }),
];
