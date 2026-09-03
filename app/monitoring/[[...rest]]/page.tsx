import { legacyRedirect, type LegacyProps } from "@/lib/legacy-redirect";

/** `/monitoring/...` before the team was in the address. */
export default async function LegacyMonitoring(props: LegacyProps) {
  await legacyRedirect("monitoring", props);
}
