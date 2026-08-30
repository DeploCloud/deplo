// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Aggregated Drizzle schema for the Postgres backend.
 */

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
export * from "./schema/control-plane";

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
import * as controlPlane from "./schema/control-plane";

/**
 * Note the key names: Better Auth's Drizzle adapter resolves a model to
 * `schema[modelName]`, so `users` (spread in from control-plane) is what `user: {
 * modelName: "users" }` binds its `user` model to.
 */
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
  ...controlPlane,
};
