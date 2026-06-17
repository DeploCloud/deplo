"use server";

import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "./result";
import { assertUser } from "../auth";
import { signState } from "../crypto";
import { resolveManifestBaseUrl, PUBLIC_URL_PLACEHOLDER } from "../public-url";
import { buildManifest, manifestCreateUrl } from "../github/manifest";
import {
  listInstallationRepos,
  listRepoBranches,
  type GithubRepoSummary,
} from "../github/app";
import { removeGithubApp } from "../data/github";

export interface GithubConnectStart {
  actionUrl: string;
  /** JSON manifest the browser POSTs to GitHub as a hidden form field. */
  manifest: string;
  /** Signed CSRF state echoed back to our callback. */
  state: string;
}

/**
 * Begin the GitHub App manifest flow. Returns the GitHub URL to POST to and the
 * manifest + signed state; the client renders a hidden self-submitting form so
 * the browser navigates to GitHub to create the App.
 */
export async function startGithubConnectAction(
  org?: string,
): Promise<ActionResult<GithubConnectStart>> {
  return run(async () => {
    const user = await assertUser();
    // The manifest base is baked permanently into the App on GitHub, so it must
    // be an explicit, externally-reachable URL — never a request-host guess.
    const base = resolveManifestBaseUrl();
    if (base === PUBLIC_URL_PLACEHOLDER) {
      throw new Error(
        "Set DEPLO_PUBLIC_URL to a public, externally-reachable URL (not localhost) so GitHub can reach this instance before connecting.",
      );
    }
    const manifest = buildManifest(base);
    return {
      actionUrl: manifestCreateUrl(org),
      manifest: JSON.stringify(manifest),
      state: signState(`github:${user.id}`),
    };
  });
}

export async function listGithubReposAction(
  installationId: string,
): Promise<ActionResult<GithubRepoSummary[]>> {
  return run(async () => {
    await assertUser();
    return listInstallationRepos(installationId);
  });
}

export async function listGithubBranchesAction(
  installationId: string,
  fullName: string,
): Promise<ActionResult<string[]>> {
  return run(async () => {
    await assertUser();
    return listRepoBranches(installationId, fullName);
  });
}

export async function removeGithubAppAction(
  id: string,
): Promise<ActionResult> {
  const res = await run(() => removeGithubApp(id));
  if (res.ok) revalidatePath("/settings");
  return res as ActionResult;
}
