import { legacyRedirect, type LegacyProps } from "@/lib/legacy-redirect";

/** `/variables/...` before the team was in the address. */
export default async function LegacyVariables(props: LegacyProps) {
  await legacyRedirect("variables", props);
}
