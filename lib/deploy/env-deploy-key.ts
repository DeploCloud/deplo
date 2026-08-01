/**
 * The per-(App, Environment) DEPLOY KEY (ADR-0008 Phase 3b).
 *
 * Every stack artifact is keyed on a slug today: the container `deplo-<slug>`,
 * the on-disk stack file `<slug>.yml`, the files dir `files/<slug>`, and the
 * Traefik router/service `baseKey` `deplo-<slug>`. When an App gains isolated
 * per-Environment deploy targets, each (app, environment) pair needs its OWN
 * globally-unique key that plays that role.
 *
 * The scheme, chosen for ZERO churn to existing stacks:
 *   - the **default** environment (seeded: Production) keeps the **bare** slug, so
 *     every already-running container / stack file / volume / cert is byte-
 *     identical and untouched;
 *   - every **other** environment gets `<slug>__<envSlug>`, using the SAME `__`
 *     separator [routing.ts](./routing.ts) already relies on. Because a slug is
 *     `[a-z0-9-]` (it can never contain `__`), `deplo-<slug>__<envSlug>` can never
 *     byte-collide with another app's bare `deplo-<otherslug>` — the exact
 *     guarantee the routing layer engineers for its `__<port>` suffixes.
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
