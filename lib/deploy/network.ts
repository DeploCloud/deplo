/**
 * The Docker network a stack joins. One per Environment, so a service name means
 * one container and nothing crosses an Environment boundary.
 * https://deplo.build/docs/advanced/network-isolation
 */

/**
 * The platform's own network: Traefik and the control plane, never a tenant.
 * It is also the compose KEY every rendered stack declares its network under -
 * only the `name:` underneath changes - so an authored `networks: [deplo]` lands
 * on the app's own network instead of the panel's.
 */
export const INFRA_NETWORK = "deplo";

/** The platform's networks, none of which a tenant stack may ever join. */
export const PLATFORM_NETWORKS = [
  INFRA_NETWORK,
  "deplo-internal",
  "deplo-socket",
] as const;

/**
 * Where an App or a managed database lives. An Environment owns its network; one
 * with no Environment (top level, or inside a folder) falls back to its team's, so
 * the single-user path keeps working exactly as it did.
 */
export function appNetwork(a: {
  environmentId?: string | null;
  teamId: string;
}): string {
  return a.environmentId
    ? `deplo-env-${a.environmentId}`
    : `deplo-team-${a.teamId}`;
}

/**
 * A pull request preview gets its own network and reaches nothing: the code in a
 * pull request is a stranger's, and production is one DNS lookup away otherwise.
 */
export function previewNetwork(deployKey: string): string {
  return `deplo-preview-${deployKey}`;
}

/**
 * A pull request preview's own network. It holds that preview and nothing else, so
 * nothing there is a neighbour and no name on it is taken.
 */
export function isPreviewNetwork(name: string): boolean {
  return name.startsWith("deplo-preview-");
}

/** Whether a name is one Deplo mints for a tenant - never a platform network. */
export function isTenantNetwork(name: string): boolean {
  return (
    name.startsWith("deplo-env-") ||
    name.startsWith("deplo-team-") ||
    name.startsWith("deplo-preview-")
  );
}

/**
 * The network a deploy writes. The only place the preview/placement choice is
 * made, so the deploy, the reroute and the compose preview cannot drift.
 */
export function deployNetwork(
  a: { environmentId?: string | null; teamId: string },
  previewDeployKey?: string | null,
): string {
  return previewDeployKey ? previewNetwork(previewDeployKey) : appNetwork(a);
}

/**
 * Docker's own words when the daemon has no address space left, said the way an
 * operator can act on. Its default pools top out at ~31 networks, and one per
 * Environment is what finally reaches that ceiling on a host installed before the
 * installer began widening them.
 */
export function explainNetworkError(message: string): string {
  // Docker has worded this differently across versions, and the hosts that hit the
  // ceiling are precisely the OLD ones - matching only the current wording would
  // miss the whole population this message exists for.
  if (
    !/predefined address pools|non-overlapping ipv4 address pool|could not find an available/i.test(
      message,
    )
  )
    return message;
  return (
    `${message}\n\nThis server has run out of Docker networks (the default is about ` +
    `31). Set "default-address-pools" in /etc/docker/daemon.json and restart Docker, ` +
    `or remove unused networks from Servers -> Cleanup.`
  );
}
