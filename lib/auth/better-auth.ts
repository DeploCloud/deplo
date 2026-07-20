import "server-only";

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import { getPool, isPostgresEnabled } from "@/lib/db/pg";
import { schema } from "@/lib/db/schema";

/**
 * Better Auth configuration.
 *
 * Postgres is Deplo's only data store, so Better Auth is the auth path for every
 * real run; it is constructed lazily and exposes the standard credential
 * endpoints at `/api/auth/*`. `DEPLO_SECRET` is reused as the signing secret so
 * there is one root secret to manage. `getAuth()` returns null only in the
 * test-only in-memory mode (no `DEPLO_DATABASE_URL`), where Better Auth has no
 * database to back its user / session / account tables.
 */

function createAuth() {
  const db = drizzle(getPool(), { schema });
  return betterAuth({
    appName: "Deplo",
    secret: process.env.DEPLO_SECRET,
    baseURL: process.env.DEPLO_PUBLIC_URL || undefined,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: {
      enabled: true,
      // Accounts are created via first-run setup / registration links only —
      // never through the public /api/auth/sign-up/email endpoint.
      disableSignUp: true,
      minPasswordLength: 10,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // refresh daily
    },
    advanced: {
      // Cookies are Secure when the instance is actually served over HTTPS.
      useSecureCookies: (process.env.DEPLO_PUBLIC_URL ?? "").startsWith("https://"),
    },
  });
}

let instance: ReturnType<typeof createAuth> | null = null;

export function getAuth(): ReturnType<typeof createAuth> | null {
  if (!isPostgresEnabled()) return null;
  if (!instance) instance = createAuth();
  return instance;
}

export function isBetterAuthEnabled(): boolean {
  return isPostgresEnabled();
}
