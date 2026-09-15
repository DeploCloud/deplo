import { legacyRedirect, type LegacyProps } from "@/lib/legacy-redirect";

export default async function LegacyMembers(props: LegacyProps) {
  await legacyRedirect("members", props);
}
