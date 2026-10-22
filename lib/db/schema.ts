export {
  session,
  account,
  verification,
  twoFactor,
  passkey,
  oauthClient,
  oauthConsent,
  oauthAccessToken,
  oauthRefreshToken,
  oauthResource,
  oauthClientResource,
  oauthClientAssertion,
} from "./schema/auth";
export { schedulerLease } from "./schema/scheduler";
export * from "./schema/control-plane/access-control";
export * from "./schema/control-plane/activity";
export * from "./schema/control-plane/api-tokens";
export * from "./schema/control-plane/apps";
export * from "./schema/control-plane/backups";
export * from "./schema/control-plane/crons";
export * from "./schema/control-plane/databases";
export * from "./schema/control-plane/deployments";
export * from "./schema/control-plane/display-order";
export * from "./schema/control-plane/docker-cleanup";
export * from "./schema/control-plane/domains";
export * from "./schema/control-plane/env-vars";
export * from "./schema/control-plane/identity";
export * from "./schema/control-plane/instance";
export * from "./schema/control-plane/integrations";
export * from "./schema/control-plane/migration";
export * from "./schema/control-plane/notifications";
export * from "./schema/control-plane/projects";
export * from "./schema/control-plane/servers";

import {
  session,
  account,
  verification,
  twoFactor,
  passkey,
  oauthClient,
  oauthConsent,
  oauthAccessToken,
  oauthRefreshToken,
  oauthResource,
  oauthClientResource,
  oauthClientAssertion,
} from "./schema/auth";
import { schedulerLease } from "./schema/scheduler";
import * as cpAccessControl from "./schema/control-plane/access-control";
import * as cpActivity from "./schema/control-plane/activity";
import * as cpApiTokens from "./schema/control-plane/api-tokens";
import * as cpApps from "./schema/control-plane/apps";
import * as cpBackups from "./schema/control-plane/backups";
import * as cpCrons from "./schema/control-plane/crons";
import * as cpDatabases from "./schema/control-plane/databases";
import * as cpDeployments from "./schema/control-plane/deployments";
import * as cpDisplayOrder from "./schema/control-plane/display-order";
import * as cpDockerCleanup from "./schema/control-plane/docker-cleanup";
import * as cpDomains from "./schema/control-plane/domains";
import * as cpEnvVars from "./schema/control-plane/env-vars";
import * as cpIdentity from "./schema/control-plane/identity";
import * as cpInstance from "./schema/control-plane/instance";
import * as cpIntegrations from "./schema/control-plane/integrations";
import * as cpMigration from "./schema/control-plane/migration";
import * as cpNotifications from "./schema/control-plane/notifications";
import * as cpProjects from "./schema/control-plane/projects";
import * as cpServers from "./schema/control-plane/servers";

// Better Auth resolves a model to schema[modelName], so users backs its user model (ADR-0014).
export const schema = {
  session,
  account,
  verification,
  twoFactor,
  passkey,
  oauthClient,
  oauthConsent,
  oauthAccessToken,
  oauthRefreshToken,
  oauthResource,
  oauthClientResource,
  oauthClientAssertion,
  schedulerLease,
  ...cpAccessControl,
  ...cpActivity,
  ...cpApiTokens,
  ...cpApps,
  ...cpBackups,
  ...cpCrons,
  ...cpDatabases,
  ...cpDeployments,
  ...cpDisplayOrder,
  ...cpDockerCleanup,
  ...cpDomains,
  ...cpEnvVars,
  ...cpIdentity,
  ...cpInstance,
  ...cpIntegrations,
  ...cpMigration,
  ...cpNotifications,
  ...cpProjects,
  ...cpServers,
};
