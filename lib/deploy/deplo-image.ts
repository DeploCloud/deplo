// `deplo/<key>:<deployment>` is where every Deplo build is tagged (deployImageRef); a name a user writes
// there would run, on a shared server, the image Deplo built for another app.
const DOCKER_HUB = new Set([
  "docker.io",
  "index.docker.io",
  "registry-1.docker.io",
  "registry.hub.docker.com",
]);

/** "deplo" when the image lands in deplo/ on Docker Hub, "unknown" when a variable fills the part that decides it. */
export function deploImageClaim(ref: string): "deplo" | "unknown" | null {
  const r = ref.trim().toLowerCase().split("@")[0];
  const parts = r.split("/");
  if (parts.length === 1) return /^[^:]*\$/.test(r) ? "unknown" : null;
  const head = parts[0];
  if (head.includes("$")) return "unknown";
  const isHost = head === "localhost" || /[.:]/.test(head);
  if (isHost && !DOCKER_HUB.has(head)) return null;
  const namespace = isHost ? parts[1] : head;
  if (isHost && parts.length === 2)
    return /^[^:]*\$/.test(namespace) ? "unknown" : null;
  if (namespace.includes("$")) return "unknown";
  return namespace === "deplo" ? "deplo" : null;
}

// `who` names what uses the image: "This app", "This database", or a compose service.
export function deploImageMessage(
  image: string,
  claim: "deplo" | "unknown",
  who = "This app",
): string {
  if (claim === "unknown")
    return (
      `${who} takes its image name from a variable, so Deplo cannot tell whether it is one of the ` +
      `images Deplo builds for apps (under \`deplo/\`). Write the image name out; a variable in the tag is fine.`
    );
  return (
    `${who} uses \`${image}\`, a name under \`deplo/\`, where Deplo keeps the images it builds for ` +
    `apps on this server. Use an image from a registry, or let Deplo build this one from its source.`
  );
}

/** The first service whose image lands in deplo/, or might; `ownPrefix` spares the name Deplo gives a service it builds. */
export function serviceDeploImage(
  services: Record<string, unknown>,
  ownPrefix?: string,
): { service: string; image: string; claim: "deplo" | "unknown" } | null {
  for (const [service, svc] of Object.entries(services)) {
    if (!svc || typeof svc !== "object") continue;
    const s = svc as Record<string, unknown>;
    const image = typeof s.image === "string" ? s.image : "";
    const claim = image ? deploImageClaim(image) : null;
    if (!claim) continue;
    if (ownPrefix && s.build != null && image.startsWith(ownPrefix)) continue;
    return { service, image, claim };
  }
  return null;
}
