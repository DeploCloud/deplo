import "server-only";

import { assertComposeWithinLimits } from "../../deploy/compose-lint/document";
import { composePublishesPorts } from "../../deploy/compose-lint/host-ports";
import {
  composeHostReach,
  composeUsesExternalMerge,
  externalMergeMessage,
} from "../../deploy/compose-lint/host-privileges";
import {
  composeClaimsReservedName,
  composeInterpolatedHostname,
  interpolatedHostnameMessage,
  reservedNameMessage,
} from "../../deploy/compose-lint/networks";
import {
  isInstanceAdmin,
  requireExposePorts,
  requireMountHostVolumes,
} from "../../membership";
import { assertCloneTargetSafe } from "../../git/clone-url";
import { listGithubInstallations } from "../github";
import { gitConnectionInTeam } from "../git-connections";
import type { DeploySource } from "../../types/app";
import type { GitRepo } from "../../types/build";

export const ON_IMPORT_SOURCE =
  "That server is a migration source - it only exists to import from another platform.";

const IMAGE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/;

export function assertImageRef(
  source: DeploySource,
  dockerImage: string | null | undefined,
): void {
  if (
    source === "docker-image" &&
    dockerImage &&
    !IMAGE_REF_RE.test(dockerImage)
  )
    throw new Error(
      "Enter a valid image reference (e.g. nginx:1.27 or ghcr.io/org/app@sha256:…).",
    );
}

export async function assertComposeSavable(
  compose: string | null | undefined,
): Promise<string[]> {
  if (compose != null && composePublishesPorts(compose)) {
    await requireExposePorts();
  }
  if (compose != null) assertComposeWithinLimits(compose);
  const reach = compose != null ? composeHostReach(compose) : [];
  if (reach.length > 0) await requireMountHostVolumes(reach.join(", "));
  if (compose != null) {
    const merge = composeUsesExternalMerge(compose);
    if (merge) throw new Error(externalMergeMessage(merge));
    const claimed = composeClaimsReservedName(compose);
    if (claimed) throw new Error(reservedNameMessage(claimed));
    const filled = composeInterpolatedHostname(compose);
    if (filled) throw new Error(interpolatedHostnameMessage(filled));
  }
  return reach;
}

export async function scopeRepoCredentials(
  repo: GitRepo | null,
  teamId: string,
): Promise<GitRepo | null> {
  if (!repo) return null;
  const out: GitRepo = { ...repo };
  if (out.installationId) {
    const mine = await listGithubInstallations();
    if (!mine.some((i) => i.id === out.installationId))
      out.installationId = null;
  }
  if (
    out.connectionId &&
    !(await gitConnectionInTeam(out.connectionId, teamId))
  ) {
    out.connectionId = null;
  }
  if (!out.installationId && !out.connectionId)
    await assertCloneTargetSafe(out.url, {
      allowPrivate: await isInstanceAdmin(),
    });
  return out;
}
