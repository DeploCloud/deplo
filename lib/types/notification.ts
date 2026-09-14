import type { ID } from "./identity";

// ALL_CHANNELS - where a team's alerts are delivered. The union is derived from
// this array so there is ONE declaration and the GraphQL enum cannot drift.
// Everything after `telegram` is beta.
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

// EmailProvider - which transport delivers the team's email.
export type EmailProvider = "smtp" | "resend";

// AlertKey - one notifiable event, catalogued with its label, description and
// default in `lib/alerts.ts`. Every key here MUST have a real emitter.
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

// ALL_ALERTS - canonical order a stored set is normalised to. Keep it in step
// with `ALERT_CATEGORIES` in `lib/alerts.ts` (a test pins the two together).
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

// NotificationChannelInstance - ONE configured destination, flat like its row:
// only the fields this `kind` uses carry meaning, and the UI decides which to show.
export interface NotificationChannelInstance {
  id: ID;
  kind: NotificationChannel;
  // The team's own label, or "" - the UI falls back to the kind's own name.
  name: string;
  enabled: boolean;
  // The outbound endpoint: a webhook URL, a Gotify server, an ntfy server.
  url: string;
  // The addressee inside it: telegram chat id, ntfy topic, the email To:.
  target: string;
  emailFrom: string;
  emailProvider: EmailProvider;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  // telegram bot token · gotify token · ntfy token · pushover token · SMTP password
  secretSet: boolean;
  // pushover user key · Resend API key
  secret2Set: boolean;
  // What THIS instance is subscribed to, in `ALL_ALERTS` order.
  alerts: AlertKey[];
}

// NotificationChannelInput - what the channel modal sends for ONE instance, plus
// the plaintext credentials the user actually retyped.
export interface NotificationChannelInput extends Omit<
  NotificationChannelInstance,
  "id" | "secretSet" | "secret2Set"
> {
  secrets?: { secret?: string; secret2?: string };
}
