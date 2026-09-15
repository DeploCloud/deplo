export const INFRA_NETWORK = "deplo";

export const PLATFORM_NETWORKS = [
  INFRA_NETWORK,
  "deplo-internal",
  "deplo-socket",
] as const;

export function appNetwork(a: {
  environmentId?: string | null;
  teamId: string;
}): string {
  return a.environmentId
    ? `deplo-env-${a.environmentId}`
    : `deplo-team-${a.teamId}`;
}

export function previewNetwork(deployKey: string): string {
  return `deplo-preview-${deployKey}`;
}

export function isPreviewNetwork(name: string): boolean {
  return name.startsWith("deplo-preview-");
}

export function isTenantNetwork(name: string): boolean {
  return (
    name.startsWith("deplo-env-") ||
    name.startsWith("deplo-team-") ||
    name.startsWith("deplo-preview-")
  );
}

export function deployNetwork(
  a: { environmentId?: string | null; teamId: string },
  previewDeployKey?: string | null,
): string {
  return previewDeployKey ? previewNetwork(previewDeployKey) : appNetwork(a);
}

export function explainNetworkError(message: string): string {
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
