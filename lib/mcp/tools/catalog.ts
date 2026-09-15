import { APPS_CONFIG } from "./apps-configure";
import { APPS_OPS } from "./apps-operate";
import { APPS_READ } from "./apps-read";
import { APPS_SETTINGS } from "./apps-settings";
import {
  BACKUPS,
  BACKUPS_ADMIN,
  BACKUP_SCHEDULES,
  DESTINATIONS,
} from "./backups";
import { CRON, CRON_ADMIN } from "./cron";
import { DATABASES } from "./databases";
import { DATABASES_SETTINGS } from "./databases-settings";
import { DIAGNOSTICS } from "./diagnostics";
import { DOMAINS } from "./domains";
import { APP_SHARED_ENV, ENV, SHARED_ENV } from "./env-vars";
import { ESCAPE_HATCH } from "./escape-hatch";
import { FLEET } from "./fleet-admin";
import { GIT, GIT_CONNECTIONS } from "./git";
import { INSTANCE } from "./instance";
import { LOGS, METRICS, METRICS_HISTORY } from "./logs-and-metrics";
import { NOTIFICATIONS } from "./notifications";
import { ORGANIZATION, STRUCTURE } from "./organization";
import { PREVIEWS, PREVIEWS_ADMIN } from "./previews";
import { REGISTRIES_AND_ACCESS } from "./registries-and-access";
import { SERVERS } from "./servers";
import { TEAM, TEAM_ADMIN } from "./team";
import type { McpToolDef } from "./tool-def";

export const MCP_TOOLS: McpToolDef[] = [
  ...DIAGNOSTICS,
  ...APPS_READ,
  ...APPS_OPS,
  ...APPS_CONFIG,
  ...ENV,
  ...DOMAINS,
  ...DATABASES,
  ...LOGS,
  ...METRICS,
  ...BACKUPS,
  ...CRON,
  ...PREVIEWS,
  ...ORGANIZATION,
  ...TEAM,
  ...SHARED_ENV,
  ...BACKUP_SCHEDULES,
  ...GIT,
  ...REGISTRIES_AND_ACCESS,
  ...SERVERS,
  ...STRUCTURE,
  ...APP_SHARED_ENV,
  ...TEAM_ADMIN,
  ...APPS_SETTINGS,
  ...METRICS_HISTORY,
  ...DATABASES_SETTINGS,
  ...BACKUPS_ADMIN,
  ...CRON_ADMIN,
  ...PREVIEWS_ADMIN,
  ...FLEET,
  ...DESTINATIONS,
  ...NOTIFICATIONS,
  ...GIT_CONNECTIONS,
  ...INSTANCE,
  ...ESCAPE_HATCH,
];
