import { legacyRedirect, type LegacyProps } from "@/lib/legacy-redirect";

/** `/apps/...` before the team was in the address. */
export default async function LegacyApps(props: LegacyProps) {
  await legacyRedirect("apps", props);
}
