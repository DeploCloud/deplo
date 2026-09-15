// A slug can never contain `__`, which is the whole collision proof.
const SEP = "__";

export const PREVIEW_SUFFIX_RE = /^pr-\d+$/;

export function previewDeployKey(appSlug: string, prNumber: number): string {
  return `${appSlug}${SEP}pr-${prNumber}`;
}

export function stackName(deployKey: string): string {
  return `deplo-${deployKey}`;
}

export function stackFilesDir(deployKey: string): string {
  const dataDir = process.env.DEPLO_DATA_DIR || "/data";
  return `${dataDir}/stacks/files/${deployKey}`;
}

export function deployImageRef(
  deployKey: string,
  deploymentId: string,
): string {
  return `deplo/${deployKey}:${deploymentId.slice(0, 12)}`;
}

export function appSlugFromDeployKey(deployKey: string): string {
  const at = deployKey.indexOf(SEP);
  return at === -1 ? deployKey : deployKey.slice(0, at);
}

export function isSuffixedDeployKey(deployKey: string): boolean {
  return deployKey.includes(SEP);
}

export function prNumberFromDeployKey(deployKey: string): number | null {
  const at = deployKey.indexOf(SEP);
  if (at === -1) return null;
  const suffix = deployKey.slice(at + SEP.length);
  if (!PREVIEW_SUFFIX_RE.test(suffix)) return null;
  return Number(suffix.slice("pr-".length));
}
