import { legacyRedirect, type LegacyProps } from "@/lib/legacy-redirect";

/** `/activity/...` before the team was in the address. */
export default async function LegacyActivity(props: LegacyProps) {
  await legacyRedirect("activity", props);
}
