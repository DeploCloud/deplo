import { legacyRedirect, type LegacyProps } from "@/lib/legacy-redirect";

export default async function LegacyProjects(props: LegacyProps) {
  await legacyRedirect("projects", props);
}
