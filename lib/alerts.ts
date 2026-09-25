import type { AlertKey } from "./types/notification";
import { ALL_ALERTS } from "./types/notification";

export interface AlertMeta {
  label: string;
  description: string;
  keywords?: string;
  defaultOn: boolean;
}

export const ALERT_META: Record<AlertKey, AlertMeta> = {
  deployment_failed: {
    label: "Deployment failed",
    description: "A deployment did not finish.",
    keywords: "build error broken ship release",
    defaultOn: true,
  },
  deployment_succeeded: {
    label: "Deployment succeeded",
    description: "A deployment finished and the new version is live.",
    keywords: "build ok ship release shipped",
    defaultOn: false,
  },
  deployment_interrupted: {
    label: "Deployment interrupted",
    description: "A deployment was cut short when Deplo restarted.",
    keywords: "restart cancelled stopped build",
    defaultOn: true,
  },

  app_crash_loop: {
    label: "App keeps restarting",
    description: "An app starts, dies and starts again.",
    keywords: "crash loop down restarting unhealthy",
    defaultOn: true,
  },
  app_out_of_memory: {
    label: "App ran out of memory",
    description: "An app used all the memory it may use and was killed.",
    keywords: "oom memory ram killed limit leak",
    defaultOn: true,
  },

  database_ready: {
    label: "Database ready",
    description: "A new database finished setting up.",
    keywords: "created provisioned postgres mysql redis",
    defaultOn: false,
  },
  database_failed: {
    label: "Database setup failed",
    description: "A database could not be set up.",
    keywords: "provision error postgres mysql redis",
    defaultOn: true,
  },
  database_rebuilt: {
    label: "Database rebuilt",
    description: "A database was wiped and set up again from scratch.",
    keywords: "reset wipe factory data lost",
    defaultOn: true,
  },
  database_deleted: {
    label: "Database deleted",
    description: "A database and its data were removed.",
    keywords: "destroy drop removed data lost",
    defaultOn: true,
  },

  cron_job_failed: {
    label: "Cron job failed",
    description:
      "A scheduled command exited with an error, or its outcome is unknown.",
    keywords: "cron schedule scheduled task command error exit",
    defaultOn: true,
  },
  cron_job_succeeded: {
    label: "Cron job finished",
    description: "A scheduled command completed successfully.",
    keywords: "cron schedule scheduled task command ok",
    defaultOn: false,
  },

  backup_succeeded: {
    label: "Backup finished",
    description: "A backup completed and was uploaded.",
    keywords: "dump snapshot s3 ok",
    defaultOn: false,
  },
  backup_failed: {
    label: "Backup failed",
    description: "A backup did not complete.",
    keywords: "dump snapshot s3 error missing",
    defaultOn: true,
  },
  restore_succeeded: {
    label: "Restore finished",
    description: "A restore completed and the data is back.",
    keywords: "recover rollback snapshot ok",
    defaultOn: false,
  },
  restore_failed: {
    label: "Restore failed",
    description: "A restore did not complete.",
    keywords: "recover rollback snapshot error",
    defaultOn: true,
  },

  server_offline: {
    label: "Server offline",
    description: "A server stopped answering.",
    keywords: "down unreachable host machine dead",
    defaultOn: true,
  },
  server_online: {
    label: "Server back online",
    description: "A server started answering again.",
    keywords: "up recovered host machine",
    defaultOn: false,
  },
  server_unmanageable: {
    label: "Server cannot run apps",
    description:
      "Deplo reached a server but cannot start or stop anything on it.",
    keywords: "docker degraded warning host",
    defaultOn: true,
  },
  server_trust_changed: {
    label: "Server identity changed",
    description:
      "A server presented a different identity than the one Deplo trusts.",
    keywords: "certificate mtls security fingerprint",
    defaultOn: true,
  },
  server_resources_high: {
    label: "Server running hot",
    description: "A server's CPU or memory has been near full for a while.",
    keywords: "cpu memory ram load busy overload",
    defaultOn: true,
  },
  server_disk_low: {
    label: "Server disk almost full",
    description: "A server is close to running out of disk space.",
    keywords: "storage space full disk",
    defaultOn: true,
  },
  agent_certificate_failed: {
    label: "Server agent certificate not renewed",
    description:
      "Deplo could not renew a server's certificate and will lose access to it.",
    keywords: "mtls expiry renewal security",
    defaultOn: true,
  },
  cleanup_failed: {
    label: "Cleanup failed",
    description: "Scheduled disk cleanup did not finish on a server.",
    keywords: "prune images disk space sweep",
    defaultOn: true,
  },
  teardown_abandoned: {
    label: "Leftover containers",
    description:
      "Deplo stopped trying to remove the containers of something you deleted.",
    keywords: "orphan teardown delete stack volumes leftover",
    defaultOn: true,
  },

  deplo_update_available: {
    label: "Deplo update available",
    description: "A newer version of Deplo can be installed.",
    keywords: "version upgrade release panel",
    defaultOn: true,
  },

  member_joined: {
    label: "Member joined",
    description: "Someone was added to the team.",
    keywords: "invite added people user",
    defaultOn: false,
  },
  member_removed: {
    label: "Member removed",
    description: "Someone was removed from the team.",
    keywords: "kicked revoked people user",
    defaultOn: false,
  },
  member_access_changed: {
    label: "Member access changed",
    description: "Someone's role or capabilities changed.",
    keywords: "role permission grant scope people",
    defaultOn: false,
  },
  token_created: {
    label: "API token created",
    description: "A new API token can now act on this team.",
    keywords: "bearer key secret automation",
    defaultOn: true,
  },
  token_revoked: {
    label: "API token revoked",
    description: "An API token was revoked.",
    keywords: "bearer key secret automation",
    defaultOn: false,
  },
  two_factor_policy_changed: {
    label: "Two-factor requirement changed",
    description: "The team's two-factor sign-in requirement changed.",
    keywords: "2fa mfa otp security policy",
    defaultOn: true,
  },
  team_ownership_changed: {
    label: "Team owner changed",
    description: "The team was handed to a different owner.",
    keywords: "transfer ownership admin",
    defaultOn: true,
  },
  failed_logins: {
    label: "Repeated failed sign-ins",
    description: "An account was hit with repeated wrong passwords.",
    keywords: "brute force attack password security login",
    defaultOn: true,
  },

  certificate_expiring: {
    label: "Certificate expiring",
    description: "A certificate is close to expiring and has not renewed.",
    keywords: "tls ssl https expiry renew",
    defaultOn: true,
  },
  git_connection_failing: {
    label: "Git connection stopped working",
    description: "A stored access token was revoked or expired.",
    keywords: "gitlab bitbucket gitea token expired revoked repository",
    defaultOn: true,
  },
  git_access_missing: {
    label: "Git provider is missing access",
    description: "A git host no longer allows something Deplo needs.",
    keywords:
      "github app permission scope grant clone webhook pull request revoked",
    defaultOn: true,
  },
  domain_dns_drift: {
    label: "Domain points elsewhere",
    description: "A domain no longer points at the server that serves it.",
    keywords: "dns a record ip moved broken",
    defaultOn: true,
  },
};

export const ALERT_CATEGORIES: {
  key: string;
  label: string;
  description: string;
  alerts: AlertKey[];
}[] = [
  {
    key: "deployments",
    label: "Deployments",
    description: "Shipping code to your apps.",
    alerts: [
      "deployment_failed",
      "deployment_succeeded",
      "deployment_interrupted",
      "git_connection_failing",
      "git_access_missing",
    ],
  },
  {
    key: "apps",
    label: "Apps",
    description: "How your running apps behave.",
    alerts: ["app_crash_loop", "app_out_of_memory"],
  },
  {
    key: "crons",
    label: "Cron jobs",
    description: "Scheduled commands running inside your containers.",
    alerts: ["cron_job_failed", "cron_job_succeeded"],
  },
  {
    key: "databases",
    label: "Databases",
    description: "Managed databases on your servers.",
    alerts: [
      "database_ready",
      "database_failed",
      "database_rebuilt",
      "database_deleted",
    ],
  },
  {
    key: "backups",
    label: "Backups & restore",
    description: "Backups and the restores that use them.",
    alerts: [
      "backup_succeeded",
      "backup_failed",
      "restore_succeeded",
      "restore_failed",
    ],
  },
  {
    key: "servers",
    label: "Servers",
    description: "The servers Deplo runs your apps on.",
    alerts: [
      "server_offline",
      "server_online",
      "server_unmanageable",
      "server_trust_changed",
      "server_resources_high",
      "server_disk_low",
      "agent_certificate_failed",
      "cleanup_failed",
      "teardown_abandoned",
    ],
  },
  {
    key: "instance",
    label: "This Deplo instance",
    description: "The panel itself, not the apps it runs.",
    alerts: ["deplo_update_available"],
  },
  {
    key: "security",
    label: "Security & team",
    description: "Who can reach this team and what they can do.",
    alerts: [
      "member_joined",
      "member_removed",
      "member_access_changed",
      "token_created",
      "token_revoked",
      "two_factor_policy_changed",
      "team_ownership_changed",
      "failed_logins",
    ],
  },
  {
    key: "domains",
    label: "Domains & TLS",
    description: "Where your apps answer and the certificates they use.",
    alerts: ["certificate_expiring", "domain_dns_drift"],
  },
];

export const DEFAULT_ALERTS: AlertKey[] = ALL_ALERTS.filter(
  (a) => ALERT_META[a].defaultOn,
);

export function alertSearchText(alert: AlertKey): string {
  const meta = ALERT_META[alert];
  return `${alert} ${meta.label} ${meta.description} ${meta.keywords ?? ""}`
    .toLowerCase()
    .replace(/_/g, " ");
}

export function searchAlerts(query: string): AlertKey[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...ALL_ALERTS];
  return ALL_ALERTS.filter((a) => {
    const text = alertSearchText(a);
    return terms.every((t) => text.includes(t));
  });
}
