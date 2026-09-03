import { legacyRedirect, type LegacyProps } from "@/lib/legacy-redirect";

/** `/projects/...` before the team was in the address. */
export default async function LegacyProjects(props: LegacyProps) {
  await legacyRedirect("projects", props);
}
