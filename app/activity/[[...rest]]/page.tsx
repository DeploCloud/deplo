import { legacyRedirect, type LegacyProps } from "@/lib/legacy-redirect";

export default async function LegacyActivity(props: LegacyProps) {
  await legacyRedirect("activity", props);
}
