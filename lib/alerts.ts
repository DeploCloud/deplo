import type { AlertKey, NotificationSettings } from "./types";
import { ALL_ALERTS } from "./types";

/**
 * The alert catalog — one entry per thing Deplo will tell a team about, plus the
 * categories the notification settings browse them by.
 *
 * Deliberately FINE-GRAINED, and deliberately shaped exactly like the capability
 * catalog next door (`lib/capabilities.ts`): same meta record, same category
 * array, same search text, and the same picker UI on top. Somebody who has
 * already ticked permissions for a role knows how to tick alerts.
 *
 * The one rule that governs what may be listed here: **every key must have a
 * real emitter**. A key nobody dispatches is a switch that promises an alert and
 * delivers silence, which is the exact bug this feature exists to close. When
 * adding a key, add its `dispatchAlert` call in the same change.
 *
 * No server-only or request-context imports: the settings panel is a client
 * component and reads this catalog directly.
 */

/** How an alert is shown in the notification settings. */
export interface AlertMeta {
  label: string;
  /** One line, in the terms the dashboard uses. */
  description: string;
  /** Extra weight in search: words a user might type that aren't in the label. */
  keywords?: string;
  /** What a team gets before it ever opens this page. */
  defaultOn: boolean;
}

export const ALERT_META: Record<AlertKey, AlertMeta> = {
  /* ---- Deployments ---- */
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

  /* ---- Apps ---- */
  app_crash_loop: {
    label: "App keeps restarting",
    description: "An app starts, dies and starts again.",
    keywords: "crash loop down restarting unhealthy",
    defaultOn: true,
  },

  /* ---- Databases ---- */
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

  /* ---- Backups & restore ---- */
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

  /* ---- Servers & agent ---- */
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
    description: "Deplo reached a server but cannot start or stop anything on it.",
    keywords: "docker degraded warning host",
    defaultOn: true,
  },
  server_trust_changed: {
    label: "Server identity changed",
    description: "A server presented a different identity than the one Deplo trusts.",
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
  agent_update_available: {
    label: "Server agent update available",
    description: "A newer server agent can be installed.",
    keywords: "version outdated upgrade host",
    defaultOn: true,
  },
  agent_certificate_failed: {
    label: "Server agent certificate not renewed",
    description: "Deplo could not renew a server's certificate and will lose access to it.",
    keywords: "mtls expiry renewal security",
    defaultOn: true,
  },
  cleanup_failed: {
    label: "Cleanup failed",
    description: "Scheduled disk cleanup did not finish on a server.",
    keywords: "prune images disk space sweep",
    defaultOn: true,
  },

  /* ---- This Deplo instance ---- */
  deplo_update_available: {
    label: "Deplo update available",
    description: "A newer version of Deplo can be installed.",
    keywords: "version upgrade release panel",
    defaultOn: true,
  },

  /* ---- Security & team ---- */
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

  /* ---- Domains & TLS ---- */
  certificate_expiring: {
    label: "Certificate expiring",
    description: "A certificate is close to expiring and has not renewed.",
    keywords: "tls ssl https expiry renew",
    defaultOn: true,
  },
  domain_dns_drift: {
    label: "Domain points elsewhere",
    description: "A domain no longer points at the server that serves it.",
    keywords: "dns a record ip moved broken",
    defaultOn: true,
  },
};

/**
 * The notification settings' browse order. Every alert appears in exactly one
 * category, and a category is a place to LOOK, not a thing to subscribe to.
 */
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
    ],
  },
  {
    key: "apps",
    label: "Apps",
    description: "How your running apps behave.",
    alerts: ["app_crash_loop"],
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
      "agent_update_available",
      "agent_certificate_failed",
      "cleanup_failed",
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

/**
 * What a team is subscribed to before it ever opens the settings — and what an
 * alert key added in a LATER release falls back to for every existing team, so
 * a new alert never needs a backfill (`notification_alerts` stores a row only
 * for keys the team has actually decided about).
 */
export const DEFAULT_ALERTS: AlertKey[] = ALL_ALERTS.filter(
  (a) => ALERT_META[a].defaultOn,
);

/** Lower-cased haystack for the alert picker's search box. */
export function alertSearchText(alert: AlertKey): string {
  const meta = ALERT_META[alert];
  return `${alert} ${meta.label} ${meta.description} ${meta.keywords ?? ""}`
    .toLowerCase()
    .replace(/_/g, " ");
}

/** Alerts matching a free-text query, in catalog order (empty ⇒ all). */
export function searchAlerts(query: string): AlertKey[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...ALL_ALERTS];
  return ALL_ALERTS.filter((a) => {
    const text = alertSearchText(a);
    return terms.every((t) => text.includes(t));
  });
}

/** Default notification settings for a team that has none persisted yet. */
export function defaultNotificationSettings(): NotificationSettings {
  return {
    channels: {
      push: { enabled: false },
      email: {
        enabled: false,
        address: "",
        from: "",
        provider: "smtp",
        smtp: { host: "", port: 587, user: "", passwordSet: false },
        resend: { apiKeySet: false },
      },
      discord: { enabled: false, webhookUrl: "" },
      slack: { enabled: false, webhookUrl: "" },
      telegram: { enabled: false, chatId: "", botTokenSet: false },
      webhook: { enabled: false, url: "" },
    },
    alerts: [...DEFAULT_ALERTS],
  };
}
