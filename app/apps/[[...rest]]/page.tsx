import { legacyRedirect, type LegacyProps } from "@/lib/legacy-redirect";

export default async function LegacyApps(props: LegacyProps) {
  await legacyRedirect("apps", props);
}
