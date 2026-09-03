import { legacyRedirect, type LegacyProps } from "@/lib/legacy-redirect";

/** `/deployments/...` before the team was in the address. */
export default async function LegacyDeployments(props: LegacyProps) {
  await legacyRedirect("deployments", props);
}
