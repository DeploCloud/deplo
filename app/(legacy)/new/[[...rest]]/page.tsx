import { legacyRedirect, type LegacyProps } from "@/lib/legacy-redirect";

export default async function LegacyNew(props: LegacyProps) {
  await legacyRedirect("new", props);
}
