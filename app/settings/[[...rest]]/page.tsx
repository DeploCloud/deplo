import { legacyRedirect, type LegacyProps } from "@/lib/legacy-redirect";

/** `/settings/...` before the team was in the address. */
export default async function LegacySettings(props: LegacyProps) {
  await legacyRedirect("settings", props);
}
