import * as z from "zod";
import { serverId, tool, type McpToolDef } from "./tool-def";

export const INSTANCE: McpToolDef[] = [
  tool({
    name: "get_instance",
    title: "Read this Deplo's own settings",
    description:
      "The panel's address, version, log retention, and whether an update is available.",
    group: "Instance",
    requires: "instanceAdmin",
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpInstance {
        instanceSettings {
          version
          panelUrl
          panelUrlSource
          storedPanelUrl
          panelFallbackUrl
          logMaxDays
          deploHostName
          deploHostIp
        }
        updateInfo {
          current
          latest
          updateAvailable
          publishedAt
          url
          checkedAt
          error
        }
      }
    `,
  }),
  tool({
    name: "check_for_updates",
    title: "Check for a Deplo update",
    description: "Look up the newest Deplo release right now.",
    group: "Instance",
    requires: "instanceAdmin",
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      mutation McpCheckForUpdates {
        checkForUpdates {
          current
          latest
          updateAvailable
          publishedAt
          url
        }
      }
    `,
  }),
  tool({
    name: "read_changelog",
    title: "Read Deplo's changelog",
    description: "The recent releases and what changed in each.",
    group: "Instance",
    requires: "instanceAdmin",
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpChangelog {
        deploChangelog {
          error
          releases {
            tag
            name
            publishedAt
            prerelease
            body
          }
        }
      }
    `,
  }),
  tool({
    name: "set_panel_url",
    title: "Set the panel's public address",
    description:
      "The address Deplo publishes for itself (webhooks, OAuth, agents). Null goes back to the detected one.",
    group: "Instance",
    requires: "instanceAdmin",
    idempotent: true,
    input: z.object({ url: z.string().nullable() }),
    query: /* GraphQL */ `
      mutation McpSetPanelUrl($url: String) {
        setPanelUrl(url: $url) {
          panelUrl
          panelUrlSource
        }
      }
    `,
  }),
  tool({
    name: "set_panel_https",
    title: "Turn HTTPS for the panel on or off",
    description:
      "Serve the panel over HTTPS through the Deplo host's proxy, with a certificate for the panel's domain.",
    group: "Instance",
    requires: "instanceAdmin",
    idempotent: true,
    input: z.object({ enabled: z.boolean() }),
    query: /* GraphQL */ `
      mutation McpSetPanelHttps($enabled: Boolean!) {
        setPanelHttps(enabled: $enabled) {
          enabled
          domain
          certificateTrusted
          unavailable
        }
      }
    `,
  }),
  tool({
    name: "set_log_retention",
    title: "Set how many days of logs are kept",
    description: "Log retention for every app and database on this Deplo.",
    group: "Instance",
    requires: "instanceAdmin",
    idempotent: true,
    input: z.object({ days: z.number().int().min(1) }),
    query: /* GraphQL */ `
      mutation McpSetLogMaxDays($days: Int!) {
        setLogMaxDays(days: $days) {
          logMaxDays
        }
      }
    `,
  }),
  tool({
    name: "restart_panel",
    title: "Restart the Deplo panel",
    description:
      "Restart the control plane itself, on the server that runs it. Every dashboard session is interrupted for a moment.",
    group: "Instance",
    requires: "instanceAdmin",
    destructive: true,
    input: z.object({ serverId: serverId.describe("The Deplo host's id.") }),
    variables: (a) => ({ id: a.serverId }),
    query: /* GraphQL */ `
      mutation McpRestartPanel($id: String!) {
        restartDeploPanel(id: $id)
      }
    `,
  }),
];
