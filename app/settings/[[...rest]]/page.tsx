import { legacyRedirect, type LegacyProps } from "@/lib/legacy-redirect";

export default async function LegacySettings(props: LegacyProps) {
  await legacyRedirect("settings", props);
}
