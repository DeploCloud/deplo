import { legacyRedirect, type LegacyProps } from "@/lib/legacy-redirect";

export default async function LegacyVariables(props: LegacyProps) {
  await legacyRedirect("variables", props);
}
