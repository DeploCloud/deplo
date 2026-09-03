import { legacyRedirect, type LegacyProps } from "@/lib/legacy-redirect";

/** `/servers/...` before the team was in the address. */
export default async function LegacyServers(props: LegacyProps) {
  await legacyRedirect("servers", props);
}
