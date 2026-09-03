import { legacyRedirect, type LegacyProps } from "@/lib/legacy-redirect";

/** `/members/...` before the team was in the address. */
export default async function LegacyMembers(props: LegacyProps) {
  await legacyRedirect("members", props);
}
