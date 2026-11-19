import { legacyRedirect, type LegacyProps } from "@/lib/legacy-redirect";

export default async function LegacyMonitoring(props: LegacyProps) {
  await legacyRedirect("monitoring", props);
}
