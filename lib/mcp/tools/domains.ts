import * as z from "zod";
import { appId, tool, type McpToolDef } from "./tool-def";

const DOMAIN_FIELDS = /* GraphQL */ `
  id
  appId
  name
  primary
  status
  ssl
  certProvider
  service
  port
  pathPrefix
  entrypoint
  proxied
`;

export const DOMAINS: McpToolDef[] = [
  tool({
    name: "list_domains",
    title: "List domains",
    description:
      "Domains for one app, or every domain in the team. Shows DNS/certificate status.",
    group: "Domains",
    requires: "view",
    readOnly: true,
    idempotent: true,
    input: z.object({ appId: appId.optional() }),
    query: /* GraphQL */ `
      query McpListDomains($appId: String) { domains(appId: $appId) { ${DOMAIN_FIELDS} } }
    `,
  }),
  tool({
    name: "add_domain",
    title: "Add a domain",
    description:
      "Point a hostname at an app. Certificates stay off unless you ask for letsencrypt. A multi-container app also needs the container this hostname routes to.",
    group: "Domains",
    requires: "manage_domains",
    input: z.object({
      appId,
      name: z.string().describe("The hostname, e.g. api.acme.com."),
      service: z
        .string()
        .optional()
        .describe(
          "Multi-container app only, and required there: the compose service that serves this hostname. get_app returns the compose file with the names.",
        ),
      port: z
        .number()
        .int()
        .optional()
        .describe(
          "Container port to route to. Required on a multi-container app.",
        ),
      certProvider: z.enum(["none", "letsencrypt", "custom"]).optional(),
      pathPrefix: z
        .string()
        .optional()
        .describe(
          'Serve this app under a path of the hostname, e.g. "/api". Omit to serve the whole host.',
        ),
      stripPrefix: z
        .boolean()
        .optional()
        .describe(
          "Remove the path prefix before the container sees the request.",
        ),
    }),
    query: /* GraphQL */ `
      mutation McpAddDomain($appId: String!, $name: String!, $config: DomainConfigInput) {
        addDomain(appId: $appId, name: $name, config: $config) { ${DOMAIN_FIELDS} }
      }
    `,
    variables: (a) => ({
      appId: a.appId,
      name: a.name,
      config: {
        service: a.service,
        port: a.port,
        certProvider: a.certProvider,
        pathPrefix: a.pathPrefix,
        stripPrefix: a.stripPrefix,
      },
    }),
  }),
  tool({
    name: "update_domain",
    title: "Update a domain",
    description:
      "Change a domain that is already attached: its hostname, the container it routes to, its port or its certificate. Only what you pass changes.",
    group: "Domains",
    requires: "manage_domains",
    idempotent: true,
    input: z.object({
      id: z.string().describe("The domain's id, as returned by list_domains."),
      name: z.string().optional().describe("A different hostname."),
      service: z
        .string()
        .optional()
        .describe(
          "Multi-container app only: the compose service that serves it.",
        ),
      port: z.number().int().optional().describe("Container port to route to."),
      certProvider: z.enum(["none", "letsencrypt", "custom"]).optional(),
    }),
    query: /* GraphQL */ `
      mutation McpUpdateDomain($id: String!, $patch: DomainPatchInput!) {
        updateDomain(id: $id, patch: $patch) { ${DOMAIN_FIELDS} }
      }
    `,
    variables: (a) => ({
      id: a.id,
      patch: {
        name: a.name,
        service: a.service,
        port: a.port,
        certProvider: a.certProvider,
      },
    }),
  }),
  tool({
    name: "verify_domain",
    title: "Verify a domain",
    description:
      "Re-check DNS and issue or renew the certificate. Run this after changing a DNS record.",
    group: "Domains",
    requires: "manage_domains",
    idempotent: true,
    input: z.object({ id: z.string().describe("The domain's id.") }),
    query: /* GraphQL */ `
      mutation McpVerifyDomain($id: String!) { verifyDomain(id: $id) { ${DOMAIN_FIELDS} } }
    `,
  }),
  tool({
    name: "set_primary_domain",
    title: "Make a domain primary",
    description:
      "Choose the canonical hostname; the app's URL follows it everywhere in Deplo.",
    group: "Domains",
    requires: "manage_domains",
    idempotent: true,
    input: z.object({ id: z.string().describe("The domain's id.") }),
    query: /* GraphQL */ `
      mutation McpSetPrimaryDomain($id: String!) {
        setPrimaryDomain(id: $id)
      }
    `,
  }),
  tool({
    name: "remove_domain",
    title: "Remove a domain",
    description: "Stop routing a hostname to the app.",
    group: "Domains",
    requires: "manage_domains",
    destructive: true,
    input: z.object({ id: z.string().describe("The domain's id.") }),
    query: /* GraphQL */ `
      mutation McpRemoveDomain($id: String!) {
        removeDomain(id: $id)
      }
    `,
  }),
];
