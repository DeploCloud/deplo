import { legacyRedirect, type LegacyProps } from "@/lib/legacy-redirect";

export default async function LegacyTemplates(props: LegacyProps) {
  await legacyRedirect("templates", props);
}
