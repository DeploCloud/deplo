/**
 * Every link the interface makes into the user manual, in one place: a docs
 * rename is one edit here instead of a grep across two hundred components.
 * Verify with `scripts/check-docs-links.mts` after the manual moves.
 */
export const DOCS_BASE = "https://deplo.build/docs";

/**
 * Topic -> page path, with the heading anchor whenever one lands the reader on
 * the paragraph that answers the question. Troubleshooting pages are accordions
 * with no anchors, so those entries stay page-level on purpose.
 */
export const DOCS = {
  "docs.home": "",

  "install.overview": "getting-started/install",

  "deploy.sources": "guides/deploy#the-four-sources",
  "deploy.trace": "concepts/what-happens-on-a-deploy",
  "deploy.queue": "concepts/what-happens-on-a-deploy#it-waits-for-a-slot",
  "deploy.fromGit": "guides/deploy/from-git",
  "deploy.dockerImage": "guides/deploy/docker-image",
  "deploy.fromTemplate": "guides/deploy/from-template",

  "build.settings": "guides/releases/build-settings",
  "build.methods": "guides/releases/build-settings#the-four-build-methods",
  "build.fields":
    "guides/releases/build-settings#the-fields-everyone-eventually-uses",
  "build.port":
    "guides/releases/build-settings#the-port-is-the-one-people-get-wrong",
  "build.cache": "guides/releases/build-settings#build-cache",
  "build.advanced":
    "guides/releases/build-settings#advanced-settings-you-probably-do-not-need",
  "build.serversHowItWorks": "advanced/build-servers#how-it-works",

  "releases.autoDeploy": "guides/releases/automatic-deployments",
  "releases.trigger": "guides/releases/automatic-deployments#set-the-trigger",
  "releases.submodules":
    "guides/releases/automatic-deployments#optional-submodules",
  "releases.watchPaths":
    "guides/releases/automatic-deployments#optional-watch-paths",
  "releases.deployHook":
    "guides/releases/automatic-deployments#the-deploy-hook",
  "releases.rollbacks": "guides/releases/rollbacks",
  "releases.rollbackRetention": "guides/releases/rollbacks#retention",

  "git.providers": "guides/git-providers",
  "git.unlocks": "guides/git-providers#what-each-connection-unlocks",
  "git.github": "guides/git-providers/github",
  "git.githubRepos":
    "guides/git-providers/github#approve-and-pick-repositories",
  "git.connectionType":
    "guides/git-providers/git-connections#pick-the-type-and-fill-in-the-details",

  "domains.overview": "guides/networking/domains-and-https",
  "domains.dnsStates": "guides/networking/domains-and-https#dns-states",
  "domains.certificates": "guides/networking/domains-and-https#certificates",
  "domains.pathRouting": "guides/networking/domains-and-https#path-routing",
  "domains.redirects": "guides/networking/domains-and-https#redirects",
  "domains.dnsRecord": "getting-started/add-a-domain#create-an-a-record",
  "domains.noDomainYet": "getting-started/add-a-domain#no-domain-yet",
  "certificates.custom": "advanced/custom-certificates",
  "certificates.customInstall": "advanced/custom-certificates#install-one",

  "previews.overview": "guides/networking/pull-request-previews",
  "previews.turnOn": "guides/networking/pull-request-previews#turn-it-on",
  "previews.settings": "guides/networking/pull-request-previews#settings",
  "previews.forksAndSecrets":
    "guides/networking/pull-request-previews#the-two-rules-about-forks-and-secrets",
  "previews.limit": "guides/networking/pull-request-previews#over-the-limit",

  "env.overview": "guides/config/environment-variables",
  "env.types": "guides/config/environment-variables#name-it-and-set-the-type",
  "env.allApps": "guides/config/environment-variables#see-everything-at-once",
  "env.instanceWide":
    "guides/config/environment-variables#instance-wide-variables",
  "env.previewOverrides":
    "guides/config/environment-variables#preview-overrides",
  "env.shared": "guides/config/shared-variables",

  "databases.overview": "guides/data/databases",
  "databases.engine": "guides/data/databases#pick-the-engine",
  "databases.password": "guides/data/databases#set-the-password",
  "databases.hostPort": "guides/data/databases#optional-host-port",
  "databases.connect": "guides/data/databases#connect-an-app-to-it",
  "databases.lifecycle":
    "guides/data/databases#the-lifecycle-verbs-and-which-one-destroys-data",
  "databases.settings": "guides/data/databases#settings",
  "databases.move": "guides/data/databases#move-a-database-to-another-server",

  "backups.overview": "guides/data/backups-and-restore",
  "backups.destinations": "guides/data/backups-and-restore#add-a-destination",
  "backups.recoveryKey":
    "guides/data/backups-and-restore#save-the-recovery-key",
  "backups.schedule": "guides/data/backups-and-restore#schedule-a-backup",
  "backups.retention": "guides/data/backups-and-restore#set-retention",
  "backups.restore": "guides/data/backups-and-restore#restore",

  "storage.overview": "guides/data/persistent-storage",
  "storage.source": "guides/data/persistent-storage#fill-the-source",
  "storage.mountPath": "guides/data/persistent-storage#set-the-mount-path",
  "storage.container":
    "guides/data/persistent-storage#optional-pick-a-container",
  "storage.bindOptions": "guides/data/persistent-storage#bind-options",

  "logs.overview": "guides/observability/logs",
  "logs.where": "guides/observability/logs#where-to-look",
  "logs.retention": "guides/observability/logs#retention",
  "monitoring.overview": "guides/observability/monitoring",
  "monitoring.saveMetrics":
    "guides/observability/monitoring#save-metrics-on-server",
  "notifications.overview": "guides/observability/notifications-and-alerts",
  "notifications.channels":
    "guides/observability/notifications-and-alerts#channels",
  "notifications.events":
    "guides/observability/notifications-and-alerts#pick-what-each-channel-is-told-about",
  "cron.overview": "guides/observability/cron-jobs",
  "cron.turnOn": "guides/observability/cron-jobs#turn-it-on",
  "cron.create": "guides/observability/cron-jobs#create-a-job",
  "cron.history": "guides/observability/cron-jobs#reading-the-run-history",
  "console.overview": "guides/observability/console-and-files",
  "files.browse": "guides/observability/console-and-files#browse-files",

  "team.overview": "guides/team",
  "team.members": "guides/team/members",
  "team.registrationLink": "guides/team/members#get-the-link",
  "team.limitedAccess": "guides/team/members#roles-and-limited-access",
  "team.activity": "guides/team/activity",
  "team.security": "guides/team/account-security",
  "team.password": "guides/team/account-security#change-your-password",
  "team.twoFactor": "guides/team/account-security#two-factor-authentication",
  "team.passkeys": "guides/team/account-security#passkeys",
  "team.sessions": "guides/team/account-security#signed-in-devices",
  "team.requireTwoFactor":
    "guides/team/account-security#when-your-team-requires-two-factor",

  "roles.overview": "guides/roles-and-permissions",
  "roles.floorCeiling":
    "guides/roles-and-permissions#the-floor-and-the-ceiling",
  "roles.build": "guides/roles-and-permissions/roles",
  "roles.capabilities": "guides/roles-and-permissions/roles#tick-capabilities",
  "roles.sensitive":
    "guides/roles-and-permissions/roles#mind-the-sensitive-ones",
  "roles.folderGrant":
    "guides/roles-and-permissions/folder-shares#choose-the-grant",
  "capabilities.reference": "reference/capabilities",

  "servers.overview": "guides/server",
  "servers.add": "guides/server/add-a-server",
  "servers.address": "guides/server/add-a-server#set-the-address",
  "servers.role": "guides/server/add-a-server#choose-what-its-for",
  "servers.readiness":
    "guides/server/add-a-server#check-it-before-you-trust-it",
  "servers.teams": "guides/server/add-a-server#let-teams-use-it",
  "servers.cleanup": "guides/server/cleanup",
  "servers.cleanupScopes": "guides/server/cleanup#what-gets-cleaned",
  "servers.cleanupSettings": "guides/server/cleanup#settings",
  "servers.maintenance": "guides/server/maintenance-and-advanced",
  "servers.advanced": "guides/server/maintenance-and-advanced#advanced",
  "registries.overview": "guides/server/container-registries",
  "registries.add": "guides/server/container-registries#add-one",

  "compose.overview": "advanced/compose-apps",
  "compose.differences":
    "advanced/compose-apps#what-is-different-about-a-compose-app",
  "compose.flags": "advanced/compose-apps#extra-flags",
  "resources.overview": "advanced/resource-limits",
  "resources.core": "advanced/resource-limits#the-two-that-matter",
  "resources.advanced": "advanced/resource-limits#advanced-limits",
  "hostAccess.gated": "advanced/host-access-and-privileges#what-is-gated",
  "hostAccess.ports":
    "advanced/host-access-and-privileges#publishing-a-port-is-a-separate-grant",
  "hostAccess.grant": "advanced/host-access-and-privileges#how-to-grant-it",

  "tokens.overview": "advanced/api-tokens-and-oauth",
  "tokens.capabilities": "advanced/api-tokens-and-oauth#tick-capabilities",
  "tokens.scope":
    "advanced/api-tokens-and-oauth#scope-and-the-rule-that-surprises-people",
  "tokens.expiry": "advanced/api-tokens-and-oauth#expiry",
  "tokens.oauth": "advanced/api-tokens-and-oauth#connected-clients-and-oauth",
  "mcp.overview": "guides/mcp-server",
  "mcp.connect": "guides/mcp-server#connect-an-agent",
  "mcp.clients": "guides/mcp-server#see-and-revoke-what-is-connected",

  "instance.admin": "operations/instance-administration",
  "instance.users": "operations/instance-administration#users",
  "instance.owner": "operations/instance-administration#instance-owner",
  "panel.address": "operations/panel-address-and-certificates",
  "panel.https": "operations/panel-address-and-certificates#turn-on-https",
  "panel.certEmail":
    "operations/panel-address-and-certificates#the-certificate-account-email",
  "upgrade.overview": "operations/upgrade",
  "upgrade.releases": "operations/upgrade#release-history",

  "migration.dokploy": "guides/move-from-dokploy",
  "migration.coolify": "guides/move-from-coolify",
  // One guide per panel, section by section: a Coolify migration that sent people
  // to the Dokploy page described a wizard they were not looking at.
  "migration.run": "guides/move-from-dokploy#run-a-migration",
  "migration.source":
    "guides/move-from-dokploy#install-the-agent-on-the-source",
  "migration.people": "guides/move-from-dokploy#handle-the-people",
  "migration.changes":
    "guides/move-from-dokploy#what-changes-on-the-way-across",
  "migration.coolify.run": "guides/move-from-coolify#run-a-migration",
  "migration.coolify.source":
    "guides/move-from-coolify#install-the-agent-on-each-source-machine",
  "migration.coolify.people": "guides/move-from-coolify#handle-the-people",
  "migration.coolify.changes":
    "guides/move-from-coolify#what-changes-on-the-way-across",
} as const;

export type DocsTopic = keyof typeof DOCS;

export function docsUrl(topic: DocsTopic) {
  const path = DOCS[topic];
  return path ? `${DOCS_BASE}/${path}` : DOCS_BASE;
}
