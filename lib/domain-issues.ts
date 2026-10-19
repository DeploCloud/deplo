import { isReservedSharedName } from "./deploy/compose-lint/networks";
import type { Domain } from "./types/domain";

export function domainRoutingWarning(
  domain: Pick<Domain, "service">,
  isCompose: boolean,
  services: string[],
): string | null {
  if (!isCompose) return null;
  const service = (domain.service ?? "").trim();
  if (!service)
    return "This domain doesn't name a container, so nothing serves it. Edit the domain to pick one.";
  if (isReservedSharedName(service))
    return `“${service}” is a name Deplo's own network uses, so nothing serves this domain. Rename the container in the compose file, or point this domain at another one.`;
  if (services.length > 0 && !services.includes(service))
    return `This app's compose file has no container “${service}” any more, so nothing serves this domain. Edit the domain to pick one.`;
  return null;
}
