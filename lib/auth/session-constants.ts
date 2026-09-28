export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export const SESSION_COOKIE_NAME = "deplo.session_token";

export const SECURE_COOKIE_PREFIX = "__Secure-";

export function sessionCookieNames(): [string, string] {
  return [SESSION_COOKIE_NAME, `${SECURE_COOKIE_PREFIX}${SESSION_COOKIE_NAME}`];
}
