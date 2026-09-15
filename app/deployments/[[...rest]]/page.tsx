import { legacyRedirect, type LegacyProps } from "@/lib/legacy-redirect";

export default async function LegacyDeployments(props: LegacyProps) {
  await legacyRedirect("deployments", props);
}
