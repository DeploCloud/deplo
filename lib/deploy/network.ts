// https://deplo.build/docs/advanced/network-isolation

/** The platform's own network, and the compose KEY every rendered stack declares its network under. */
export const INFRA_NETWORK = "deplo";

/** The platform's networks, none of which a tenant stack may ever join. */
export const PLATFORM_NETWORKS = [
  INFRA_NETWORK,
  "deplo-internal",
  "deplo-socket",
] as const;

/** Where an App or a managed database lives; no Environment falls back to the team's. */
export function appNetwork(a: {
  environmentId?: string | null;
  teamId: string;
}): string {
  return a.environmentId
    ? `deplo-env-${a.environmentId}`
    : `deplo-team-${a.teamId}`;
}

/** A preview gets its own network and reaches nothing - a pull request's code is a stranger's. */
export function previewNetwork(deployKey: string): string {
  return `deplo-preview-${deployKey}`;
}

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

/** The network a deploy writes - the only place the preview/placement choice is made. */
export function deployNetwork(
  a: { environmentId?: string | null; teamId: string },
  previewDeployKey?: string | null,
): string {
  return previewDeployKey ? previewNetwork(previewDeployKey) : appNetwork(a);
}

/** Docker's words when the daemon has no address space left, in terms an operator can act on. */
export function explainNetworkError(message: string): string {
  // Docker has worded this differently across versions, and the hosts that hit the ceiling are the OLD ones.
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
