import "server-only";

import type { DeploData } from "./types";

export function buildSeed(): DeploData {
  return {
    users: [],
    teams: [],
    folders: [],
    memberships: [],
    invites: [],
    registrationLinks: [],
    servers: [],
    projects: [],
    deployments: [],
    logs: {},
    envVars: [],
    domains: [],
    databases: [],
    s3Destinations: [],
    backups: [],
    backupRuns: [],
    apiTokens: [],
    activities: [],
    // Per-team, keyed by team id. Empty until a team saves its first settings.
    notificationSettings: {},
    sharedEnvGroups: [],
    registries: [],
    githubApps: [],
    githubInstallations: [],
    devSshUsers: [],
    installedApps: [],
  };
}
