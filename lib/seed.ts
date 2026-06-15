import "server-only";

import type { DeploData } from "./types";

/**
 * A fresh Deplo store is EMPTY. There is no demo/mock data anywhere: every
 * project, server, database, domain, deployment and log is created only by real
 * user actions and real infrastructure. On first run the store has no users, so
 * the app routes to the setup wizard, which provisions the master server from
 * the real host (see `completeSetup` in lib/auth.ts).
 */
export function buildSeed(): DeploData {
  return {
    users: [],
    teams: [],
    servers: [],
    projects: [],
    deployments: [],
    logs: {},
    envVars: [],
    domains: [],
    databases: [],
    s3Destinations: [],
    backups: [],
    apiTokens: [],
    activities: [],
    notificationSettings: {
      channels: {
        push: { enabled: false },
        email: { enabled: false, address: "" },
        discord: { enabled: false, webhookUrl: "" },
        webhook: { enabled: false, url: "" },
      },
      events: {
        deployment_failed: true,
        deployment_succeeded: false,
        server_offline: true,
        high_resource_usage: true,
        update_available: true,
      },
    },
    sharedEnvGroups: [],
    registries: [],
  };
}
