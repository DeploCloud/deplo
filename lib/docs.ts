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
  "install.requirements": "getting-started/install#what-you-need",
  "install.hostChanges":
    "getting-started/install#what-the-installer-changes-on-the-host",
  "install.update": "getting-started/install#update-it-later",
  "install.firstApp": "getting-started/first-app",

  "concepts.howDeploWorks": "concepts/how-deplo-works",
  "concepts.hierarchy": "concepts/apps-projects-and-environments",
  "concepts.app": "concepts/apps-projects-and-environments#app",
  "concepts.appStatus":
    "concepts/apps-projects-and-environments#app-status-is-intent-not-observation",
  "concepts.folder": "concepts/apps-projects-and-environments#folder",
  "concepts.project": "concepts/apps-projects-and-environments#project",
  "concepts.environment": "concepts/apps-projects-and-environments#environment",
  "concepts.teams": "concepts/teams-and-capabilities",

  "deploy.sources": "guides/deploy#the-four-sources",
  "deploy.trace": "concepts/what-happens-on-a-deploy",
  "deploy.queue": "concepts/what-happens-on-a-deploy#it-waits-for-a-slot",
  "deploy.notDone":
    "concepts/what-happens-on-a-deploy#what-a-deploy-does-not-do",
  "deploy.fromGit": "guides/deploy/from-git",
  "deploy.gitPrivate": "guides/deploy/from-git#private-repositories",
  "deploy.gitChangeSource": "guides/deploy/from-git#change-the-source-later",
  "deploy.dockerImage": "guides/deploy/docker-image",
  "deploy.imagePort": "guides/deploy/docker-image#set-the-container-port",
  "deploy.imageRegistries": "guides/deploy/docker-image#private-registries",
  "deploy.imageSettings":
    "guides/deploy/docker-image#settings-that-matter-for-an-image-app",
  "deploy.fromTemplate": "guides/deploy/from-template",
  "deploy.templateVariant": "guides/deploy/from-template#pick-a-variant",
  "deploy.upload": "guides/deploy/upload-code",
  "deploy.uploadArchive": "guides/deploy/upload-code#choose-the-archive",

  "build.settings": "guides/releases/build-settings",
  "build.methods": "guides/releases/build-settings#the-four-build-methods",
  "build.fields":
    "guides/releases/build-settings#the-fields-everyone-eventually-uses",
  "build.port":
    "guides/releases/build-settings#the-port-is-the-one-people-get-wrong",
  "build.cache": "guides/releases/build-settings#build-cache",
  "build.advanced":
    "guides/releases/build-settings#advanced-settings-you-probably-do-not-need",
  "build.servers": "advanced/build-servers",
  "build.serversHowItWorks": "advanced/build-servers#how-it-works",
  "build.serversFallback": "advanced/build-servers#keep-the-fallback-on",

  "releases.overview": "guides/releases",
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
  "git.connections": "guides/git-providers/git-connections",
  "git.connectionType":
    "guides/git-providers/git-connections#pick-the-type-and-fill-in-the-details",

  "domains.overview": "guides/networking/domains-and-https",
  "domains.howItWorks": "guides/networking/domains-and-https#how-it-works",
  "domains.manage":
    "guides/networking/domains-and-https#add-and-manage-domains",
  "domains.dnsStates": "guides/networking/domains-and-https#dns-states",
  "domains.certificates": "guides/networking/domains-and-https#certificates",
  "domains.pathRouting": "guides/networking/domains-and-https#path-routing",
  "domains.redirects": "guides/networking/domains-and-https#redirects",
  "domains.add": "getting-started/add-a-domain",
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
  "env.sharedAvailability": "guides/config/shared-variables#set-availability",
  "env.sharedLink": "guides/config/shared-variables#use-one-in-an-app",

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
  "backups.target": "guides/data/backups-and-restore#pick-the-target",
  "backups.retention": "guides/data/backups-and-restore#set-retention",
  "backups.restore": "guides/data/backups-and-restore#restore",
  "backups.download": "guides/data/backups-and-restore#download-an-artifact",

  "storage.overview": "guides/data/persistent-storage",
  "storage.source": "guides/data/persistent-storage#fill-the-source",
  "storage.mountPath": "guides/data/persistent-storage#set-the-mount-path",
  "storage.container":
    "guides/data/persistent-storage#optional-pick-a-container",
  "storage.bindOptions": "guides/data/persistent-storage#bind-options",

  "logs.overview": "guides/observability/logs",
  "logs.where": "guides/observability/logs#where-to-look",
  "logs.toolbar": "guides/observability/logs#the-toolbar",
  "logs.retention": "guides/observability/logs#retention",
  "monitoring.overview": "guides/observability/monitoring",
  "monitoring.where": "guides/observability/monitoring#where-to-look",
  "monitoring.saveMetrics":
    "guides/observability/monitoring#save-metrics-on-server",
  "monitoring.alerts":
    "guides/observability/monitoring#alerts-that-come-from-metrics",
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
  "console.open": "guides/observability/console-and-files#open-a-console",
  "files.browse": "guides/observability/console-and-files#browse-files",

  "team.overview": "guides/team",
  "team.members": "guides/team/members",
  "team.invite": "guides/team/members#invite-somebody-new",
  "team.registrationLink": "guides/team/members#get-the-link",
  "team.limitedAccess": "guides/team/members#roles-and-limited-access",
  "team.remove": "guides/team/members#remove-somebody",
  "team.activity": "guides/team/activity",
  "team.security": "guides/team/account-security",
  "team.password": "guides/team/account-security#change-your-password",
  "team.twoFactor": "guides/team/account-security#two-factor-authentication",
  "team.recoveryCodes": "guides/team/account-security#save-the-recovery-codes",
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
  "roles.requireTwoFactor":
    "guides/roles-and-permissions/roles#optionally-require-two-factor",
  "roles.folderShares": "guides/roles-and-permissions/folder-shares",
  "roles.folderGrant":
    "guides/roles-and-permissions/folder-shares#choose-the-grant",
  "capabilities.reference": "reference/capabilities",
  "capabilities.floor": "reference/capabilities#the-floor",

  "servers.overview": "guides/server",
  "servers.add": "guides/server/add-a-server",
  "servers.address": "guides/server/add-a-server#set-the-address",
  "servers.role": "guides/server/add-a-server#choose-what-its-for",
  "servers.ports": "guides/server/add-a-server#open-the-right-ports",
  "servers.readiness":
    "guides/server/add-a-server#check-it-before-you-trust-it",
  "servers.teams": "guides/server/add-a-server#let-teams-use-it",
  "servers.roles": "advanced/server-roles",
  "servers.access": "guides/server/access",
  "servers.certificates": "guides/server/certificates",
  "servers.cleanup": "guides/server/cleanup",
  "servers.cleanupScopes": "guides/server/cleanup#what-gets-cleaned",
  "servers.cleanupSettings": "guides/server/cleanup#settings",
  "servers.maintenance": "guides/server/maintenance-and-advanced",
  "servers.advanced": "guides/server/maintenance-and-advanced#advanced",
  "servers.agent": "concepts/servers-and-the-agent",
  "servers.health": "concepts/servers-and-the-agent#health-is-not-readiness",
  "servers.deploHost":
    "concepts/servers-and-the-agent#the-deplo-host-is-a-server-too",
  "registries.overview": "guides/server/container-registries",
  "registries.add": "guides/server/container-registries#add-one",

  "compose.overview": "advanced/compose-apps",
  "compose.differences":
    "advanced/compose-apps#what-is-different-about-a-compose-app",
  "compose.flags": "advanced/compose-apps#extra-flags",
  "resources.overview": "advanced/resource-limits",
  "resources.core": "advanced/resource-limits#the-two-that-matter",
  "resources.advanced": "advanced/resource-limits#advanced-limits",
  "hostAccess.overview": "advanced/host-access-and-privileges",
  "hostAccess.gated": "advanced/host-access-and-privileges#what-is-gated",
  "hostAccess.ports":
    "advanced/host-access-and-privileges#publishing-a-port-is-a-separate-grant",
  "hostAccess.grant": "advanced/host-access-and-privileges#how-to-grant-it",

  "tokens.overview": "advanced/api-tokens-and-oauth",
  "tokens.capabilities": "advanced/api-tokens-and-oauth#tick-capabilities",
  "tokens.scope":
    "advanced/api-tokens-and-oauth#scope-and-the-rule-that-surprises-people",
  "tokens.instanceAdmin":
    "advanced/api-tokens-and-oauth#instance-admin-bit-optionally",
  "tokens.expiry": "advanced/api-tokens-and-oauth#expiry",
  "tokens.oauth": "advanced/api-tokens-and-oauth#connected-clients-and-oauth",
  "mcp.overview": "guides/mcp-server",
  "mcp.connect": "guides/mcp-server#connect-an-agent",
  "mcp.clients": "guides/mcp-server#see-and-revoke-what-is-connected",
  "mcp.limits": "guides/mcp-server#what-an-agent-can-and-cannot-do",

  "instance.admin": "operations/instance-administration",
  "instance.users": "operations/instance-administration#users",
  "instance.settings": "operations/instance-administration#instance-settings",
  "instance.owner": "operations/instance-administration#instance-owner",
  "instance.env": "operations/instance-administration#instance-wide-variables",
  "panel.address": "operations/panel-address-and-certificates",
  "panel.https": "operations/panel-address-and-certificates#turn-on-https",
  "panel.certEmail":
    "operations/panel-address-and-certificates#the-certificate-account-email",
  "upgrade.overview": "operations/upgrade",
  "upgrade.agents": "operations/upgrade#update-the-agents",
  "recovery.overview": "operations/disaster-recovery",
  "recovery.essentials": "operations/disaster-recovery#what-actually-matters",
  "recovery.appData": "operations/disaster-recovery#your-apps-data",
  "uninstall.overview": "operations/remove-a-server-or-uninstall",
  "uninstall.server":
    "operations/remove-a-server-or-uninstall#remove-a-server-from-deplo",
  "uninstall.agent":
    "operations/remove-a-server-or-uninstall#uninstall-the-agent-from-a-host",
  "uninstall.decommission":
    "operations/remove-a-server-or-uninstall#decommission-a-machine-properly",

  "migration.dokploy": "guides/move-from-dokploy",
  "migration.run": "guides/move-from-dokploy#run-a-migration",
  "migration.source":
    "guides/move-from-dokploy#install-the-agent-on-the-source",
  "migration.people": "guides/move-from-dokploy#handle-the-people",
  "migration.changes":
    "guides/move-from-dokploy#what-changes-on-the-way-across",
  "migration.afterwards": "guides/move-from-dokploy#after-it-lands",

  "reference.glossary": "reference/glossary",
  "reference.platformEnv": "reference/environment-variables",
  "reference.installers": "reference/installers",
  "reference.installerVerify":
    "reference/installers#verifying-before-you-pipe-to-a-shell",
  "reference.ports": "reference/ports-networks-and-files#ports",
  "reference.networks": "reference/ports-networks-and-files#networks",
  "reference.api": "api-reference",

  "troubleshooting.overview": "troubleshooting",
  "troubleshooting.deploys": "troubleshooting/deploys-and-builds",
  "troubleshooting.domains": "troubleshooting/domains-and-tls",
  "troubleshooting.servers": "troubleshooting/servers-and-agents",
  "troubleshooting.databases": "troubleshooting/databases-and-backups",
  "troubleshooting.signIn": "troubleshooting/sign-in-and-access",
} as const;

export type DocsTopic = keyof typeof DOCS;

export function docsUrl(topic: DocsTopic) {
  const path = DOCS[topic];
  return path ? `${DOCS_BASE}/${path}` : DOCS_BASE;
}
