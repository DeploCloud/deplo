import "server-only";

import { randomBytes } from "node:crypto";

/**
 * GitHub App Manifest flow helpers.
 *
 * Deplo creates a GitHub App for the user the way Dokploy/Coolify do: it POSTs
 * an app "manifest" to github.com/settings/apps/new; GitHub creates the App and
 * redirects back with a one-time `code` that we exchange for the App's
 * credentials (id, slug, private key, secrets). No manual copy/paste.
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
 * Build the manifest. Permissions are the minimum needed to list and clone the
 * user's repos, auto-deploy on push, and build a preview per pull request:
 *   contents: read        clone repositories
 *   metadata: read        list repositories / read repo metadata (mandatory)
 *   pull_requests: write  read pull requests AND post the one preview comment
 *                         (a pull request's conversation comment is an issue
 *                         comment, and GitHub accepts `pull_requests: write`
 *                         for it — so this covers both, with no `issues` grant)
 * plus the `push` and `pull_request` events.
 *
 * A manifest is only ever read when an App is CREATED, and GitHub has no API to
 * change an existing App's permissions or events. An instance that connected
 * GitHub before previews existed therefore keeps the old set until its owner
 * updates it on github.com — which is why `readAppCapabilities` exists and why
 * the Pull requests page says so out loud instead of showing an empty list.
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
