/**
 * The DEPLOY KEY: the one string every host-side artifact of a deploy is named
 * after.
 *
 * The container `deplo-<key>`, the on-disk stack file `<key>.yml`, the files dir
 * `files/<key>`, the named volumes `deplo-<key>-<name>`, the Traefik
 * router/service `baseKey` `deplo-<key>`, and every `slug`-shaped agent RPC all
 * take THIS, not `apps.slug`. For a plain production deploy the key IS the app
 * slug, which is why introducing it changed nothing that was already running.
 *
 * The scheme, chosen for ZERO churn to existing stacks:
 *   - production (and the **default** environment, seeded: Production) keeps the
 *     **bare** slug, so every already-running container / stack file / volume /
 *     certificate is byte-identical and untouched;
 *   - every other deploy target gets `<slug>__<suffix>`, using the SAME `__`
 *     separator [routing.ts](./routing.ts) already relies on. Because a slug is
 *     `[a-z0-9-]` (it can never contain `__`), `deplo-<slug>__<suffix>` can never
 *     byte-collide with another app's bare `deplo-<otherslug>` — the exact
 *     guarantee the routing layer engineers for its `__<port>` suffixes.
 *
 * Two suffix families exist, and they are deliberately disjoint:
 *   - `pr-<n>` — a **pull request preview** (ADR-0014), the live consumer.
 *   - `<envSlug>` — a per-Environment deploy target (ADR-0008 Phase 3b), still
 *     unbuilt. `PREVIEW_SUFFIX_RE` is what keeps an environment from ever being
 *     slugged `pr-42` and colliding with a preview of the same app.
 *
 * An App with NO environment (top-level / not in a container — the legacy,
 * additive-adoption case) passes `null` and keeps the bare slug.
 *
 * Pure on purpose (no store, no docker, no `server-only`): its interface IS its
 * test surface, exactly like [ports.ts](./ports.ts) and [env-resolve.ts](./env-resolve.ts).
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
 * The image tag one deploy of a BUILT source lands on: `deplo/<key>:<id[0:12]}`.
 *
 * Unique per deployment - nothing is ever overwritten, which is what makes a
 * previous deploy re-runnable without a rebuild. The agent tags with exactly this
 * string (it never derives one of its own) and the rendered compose references it,
 * so the three have to agree; this function is where they do.
 *
 * Only a source Deplo BUILDS gets one. A prebuilt `docker-image` source runs the
 * registry ref the user gave it, and a compose stack has no single image at all.
 */
export function deployImageRef(deployKey: string, deploymentId: string): string {
  return `deplo/${deployKey}:${deploymentId.slice(0, 12)}`;
}

/**
 * The owning app's slug for any deploy key — structural, not a query. A slug is
 * `[a-z0-9-]`, so everything before the FIRST `__` is the slug and nothing else
 * can be. This is what lets a preview key resolve back to its app with no extra
 * column, index or join.
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
