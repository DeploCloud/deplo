/**
 * The DEPLOY KEY: the one string every host-side artifact of a deploy is named
 * after.
 */

/** The fields this module reads from an Environment. A full `Environment` satisfies it. */
export interface DeployKeyEnvironment {
  /** `[a-z0-9-]` per-project key. */
  slug: string;
  /** Exactly one environment per project is the default; it owns the bare slug. */
  isDefault: boolean;
}

/**
 * The deploy key for an app in an environment: the bare app slug for the
 * default environment (or no environment), else `<slug>__<envSlug>`.
 */
export function environmentDeployKey(
  appSlug: string,
  env: DeployKeyEnvironment | null | undefined,
): string {
  if (!env || env.isDefault) return appSlug;
  return `${appSlug}__${env.slug}`;
}

/** The Docker stack / container name (`deplo-<deployKey>`) for an (app, environment). */
export function environmentStackName(
  appSlug: string,
  env: DeployKeyEnvironment | null | undefined,
): string {
  return `deplo-${environmentDeployKey(appSlug, env)}`;
}

/** The separator between an app slug and a deploy target's suffix. A slug can
 *  never contain it, which is the whole collision proof. */
const SEP = "__";

/**
 * The suffix shape reserved for pull request previews. An Environment may not be
 * slugged like one: `myapp__pr-42` must mean exactly one thing on a host.
 */
export const PREVIEW_SUFFIX_RE = /^pr-\d+$/;

/** The deploy key for a pull request preview of an app: `<slug>__pr-<n>`. */
export function previewDeployKey(appSlug: string, prNumber: number): string {
  return `${appSlug}${SEP}pr-${prNumber}`;
}

/** The Docker stack / container name for a deploy key. */
export function stackName(deployKey: string): string {
  return `deplo-${deployKey}`;
}

/**
 * The HOST directory a stack's own files live in: its config files, and every
 * `./<x>` bind a compose stack writes.
 */
export function stackFilesDir(deployKey: string): string {
  const dataDir = process.env.DEPLO_DATA_DIR || "/data";
  return `${dataDir}/stacks/files/${deployKey}`;
}

/**
 * The image tag one deploy of a BUILT source lands on: `deplo/<key>:<id[0:12]}`.
 */
export function deployImageRef(
  deployKey: string,
  deploymentId: string,
): string {
  return `deplo/${deployKey}:${deploymentId.slice(0, 12)}`;
}

/**
 * The owning app's slug for any deploy key — structural, not a query. A slug is
 * `[a-z0-9-]`, so everything before the FIRST `__` is the slug and nothing else
 * can be.
 */
export function appSlugFromDeployKey(deployKey: string): string {
  const at = deployKey.indexOf(SEP);
  return at === -1 ? deployKey : deployKey.slice(0, at);
}

/** Whether a deploy key names something other than the app's bare production
 *  stack (a pull request preview today, an Environment target later). */
export function isSuffixedDeployKey(deployKey: string): boolean {
  return deployKey.includes(SEP);
}

/** The pull request number a preview deploy key belongs to, or null when the key
 *  is not a preview key. */
export function prNumberFromDeployKey(deployKey: string): number | null {
  const at = deployKey.indexOf(SEP);
  if (at === -1) return null;
  const suffix = deployKey.slice(at + SEP.length);
  if (!PREVIEW_SUFFIX_RE.test(suffix)) return null;
  return Number(suffix.slice("pr-".length));
}
