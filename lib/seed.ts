import "server-only";

import type { DeploData } from "./types";

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
    githubApps: [],
    githubInstallations: [],
    devSshUsers: [],
  };
}
