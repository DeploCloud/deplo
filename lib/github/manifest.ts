import "server-only";

import { randomBytes } from "node:crypto";

import { signState, verifyState } from "@/lib/crypto";
import { safeReturnPath } from "@/lib/utils";

/**
 * GitHub App Manifest flow helpers.
 */

export interface AppManifest {
  name: string;
  url: string;
  hook_attributes: { url: string; active: boolean };
  redirect_url: string;
  callback_urls: string[];
  setup_url: string;
  setup_on_update: boolean;
  public: boolean;
  default_permissions: Record<string, string>;
  default_events: string[];
}

/** Where the browser POSTs the manifest to create the App (user or org scope). */
export function manifestCreateUrl(org?: string | null): string {
  return org && org.trim()
    ? `https://github.com/organizations/${encodeURIComponent(
        org.trim(),
      )}/settings/apps/new`
    : "https://github.com/settings/apps/new";
}

/**
 * Build the manifest.
 */
export function buildManifest(publicUrl: string): AppManifest {
  const base = publicUrl.replace(/\/+$/, "");
  const suffix = randomBytes(3).toString("hex");
  return {
    // App names are globally unique on GitHub; a short random suffix avoids
    // collisions across instances.
    name: `Deplo ${suffix}`,
    url: base,
    hook_attributes: { url: `${base}/api/github/webhook`, active: true },
    redirect_url: `${base}/api/github/callback`,
    callback_urls: [`${base}/api/github/callback`],
    setup_url: `${base}/api/github/setup`,
    setup_on_update: true,
    public: false,
    default_permissions: {
      contents: "read",
      metadata: "read",
      pull_requests: "write",
    },
    default_events: ["push", "pull_request"],
  };
}

export interface ManifestConversion {
  id: number;
  slug: string;
  name: string;
  client_id: string;
  client_secret: string;
  webhook_secret: string | null;
  pem: string;
  html_url: string;
}

/**
 * Exchange a one-time manifest `code` for the created App's credentials.
 * Called once, server-side, from the callback route.
 */
export async function exchangeManifestCode(
  code: string,
): Promise<ManifestConversion> {
  const res = await fetch(
    `https://api.github.com/app-manifests/${encodeURIComponent(
      code,
    )}/conversions`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Deplo",
      },
    },
  );
  if (!res.ok) {
    throw new Error(`GitHub manifest exchange failed (${res.status})`);
  }
  return (await res.json()) as ManifestConversion;
}

/* ------------------------------------------------------------------ */
/* Connect state (CSRF + where to send the browser back)               */
/* ------------------------------------------------------------------ */

/**
 * The signed `state` that rides both hops of the connect flow: the manifest POST
 * (GitHub echoes it to `/api/github/callback`) and the install link
 * (`installations/new?state=…`, which GitHub echoes to `/api/github/setup` -
 * documented as the way to "return people back to that state after they install").
 */
export function signConnectState(
  userId: string,
  returnTo?: string | null,
): string {
  const back = safeReturnPath(returnTo);
  return signState(back ? `github:${userId}:${back}` : `github:${userId}`);
}

/**
 * Verify a state minted by {@link signConnectState}.
 */
export function readConnectState(
  token: string | null | undefined,
  userId: string,
): { returnTo: string | null } | null {
  const data = verifyState(token ?? undefined);
  if (!data) return null;
  const prefix = `github:${userId}`;
  if (data === prefix) return { returnTo: null };
  if (!data.startsWith(`${prefix}:`)) return null;
  return { returnTo: safeReturnPath(data.slice(prefix.length + 1)) };
}
