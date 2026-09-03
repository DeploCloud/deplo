import { legacyRedirect, type LegacyProps } from "@/lib/legacy-redirect";

/** `/templates/...` before the team was in the address. */
export default async function LegacyTemplates(props: LegacyProps) {
  await legacyRedirect("templates", props);
}
