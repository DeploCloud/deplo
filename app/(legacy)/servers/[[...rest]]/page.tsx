import { legacyRedirect, type LegacyProps } from "@/lib/legacy-redirect";

export default async function LegacyServers(props: LegacyProps) {
  await legacyRedirect("servers", props);
}
