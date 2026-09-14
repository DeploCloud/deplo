// A slug can never contain `__`, which is the whole collision proof.
const SEP = "__";

// PREVIEW_SUFFIX_RE - the suffix reserved for previews; an Environment may not be slugged like one.
export const PREVIEW_SUFFIX_RE = /^pr-\d+$/;

// previewDeployKey - the deploy key for a pull request preview: <slug>__pr-<n>.
export function previewDeployKey(appSlug: string, prNumber: number): string {
  return `${appSlug}${SEP}pr-${prNumber}`;
}

// stackName - the Docker stack / container name for a deploy key.
export function stackName(deployKey: string): string {
  return `deplo-${deployKey}`;
}

// stackFilesDir - the host directory a stack's own files live in.
export function stackFilesDir(deployKey: string): string {
  const dataDir = process.env.DEPLO_DATA_DIR || "/data";
  return `${dataDir}/stacks/files/${deployKey}`;
}

// deployImageRef - the image tag one deploy of a built source lands on.
export function deployImageRef(
  deployKey: string,
  deploymentId: string,
): string {
  return `deplo/${deployKey}:${deploymentId.slice(0, 12)}`;
}

// appSlugFromDeployKey - everything before the first `__` is the owning app's slug.
export function appSlugFromDeployKey(deployKey: string): string {
  const at = deployKey.indexOf(SEP);
  return at === -1 ? deployKey : deployKey.slice(0, at);
}

// isSuffixedDeployKey - whether a deploy key names something other than the bare production stack.
export function isSuffixedDeployKey(deployKey: string): boolean {
  return deployKey.includes(SEP);
}

// prNumberFromDeployKey - the pull request number of a preview key, or null.
export function prNumberFromDeployKey(deployKey: string): number | null {
  const at = deployKey.indexOf(SEP);
  if (at === -1) return null;
  const suffix = deployKey.slice(at + SEP.length);
  if (!PREVIEW_SUFFIX_RE.test(suffix)) return null;
  return Number(suffix.slice("pr-".length));
}
