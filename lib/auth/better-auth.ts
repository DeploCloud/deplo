import "server-only";

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import { getPool, isPostgresEnabled } from "@/lib/db/pg";
import { schema } from "@/lib/db/schema";

/**
 * Better Auth configuration.
 *
 * Enabled only when Postgres is configured (Better Auth needs a database for its
 * user / session / account tables). It is constructed lazily so the app builds
 * and runs without a database, and exposes the standard credential endpoints at
 * `/api/auth/*`. `DEPLO_SECRET` is reused as the signing secret so there is one
 * root secret to manage.
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
