import type { ID } from "./identity";

export const ALL_CHANNELS = [
  "push",
  "email",
  "discord",
  "webhook",
  "slack",
  "telegram",
  "lark",
  "msteams",
  "gotify",
  "ntfy",
  "mattermost",
  "pushover",
] as const;

export type NotificationChannel = (typeof ALL_CHANNELS)[number];

export type EmailProvider = "smtp" | "resend";

export type AlertKey =
  | "deployment_failed"
  | "deployment_succeeded"
  | "deployment_interrupted"
  | "git_connection_failing"
  | "git_access_missing"
  | "app_crash_loop"
  | "cron_job_failed"
  | "cron_job_succeeded"
  | "database_ready"
  | "database_failed"
  | "database_rebuilt"
  | "database_deleted"
  | "backup_succeeded"
  | "backup_failed"
  | "restore_succeeded"
  | "restore_failed"
  | "server_offline"
  | "server_online"
  | "server_unmanageable"
  | "server_trust_changed"
  | "server_resources_high"
  | "server_disk_low"
  | "agent_certificate_failed"
  | "cleanup_failed"
  | "teardown_abandoned"
  | "deplo_update_available"
  | "member_joined"
  | "member_removed"
  | "member_access_changed"
  | "token_created"
  | "token_revoked"
  | "two_factor_policy_changed"
  | "team_ownership_changed"
  | "failed_logins"
  | "certificate_expiring"
  | "domain_dns_drift";

export const ALL_ALERTS: AlertKey[] = [
  "deployment_failed",
  "deployment_succeeded",
  "deployment_interrupted",
  "git_connection_failing",
  "git_access_missing",
  "app_crash_loop",
  "cron_job_failed",
  "cron_job_succeeded",
  "database_ready",
  "database_failed",
  "database_rebuilt",
  "database_deleted",
  "backup_succeeded",
  "backup_failed",
  "restore_succeeded",
  "restore_failed",
  "server_offline",
  "server_online",
  "server_unmanageable",
  "server_trust_changed",
  "server_resources_high",
  "server_disk_low",
  "agent_certificate_failed",
  "cleanup_failed",
  "teardown_abandoned",
  "deplo_update_available",
  "member_joined",
  "member_removed",
  "member_access_changed",
  "token_created",
  "token_revoked",
  "two_factor_policy_changed",
  "team_ownership_changed",
  "failed_logins",
  "certificate_expiring",
  "domain_dns_drift",
];

export interface NotificationChannelInstance {
  id: ID;
  kind: NotificationChannel;
  name: string;
  enabled: boolean;
  url: string;
  target: string;
  emailFrom: string;
  emailProvider: EmailProvider;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  secretSet: boolean;
  secret2Set: boolean;
  alerts: AlertKey[];
}

export interface NotificationChannelInput extends Omit<
  NotificationChannelInstance,
  "id" | "secretSet" | "secret2Set"
> {
  secrets?: { secret?: string; secret2?: string };
}
