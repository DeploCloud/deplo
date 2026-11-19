import { legacyRedirect, type LegacyProps } from "@/lib/legacy-redirect";

export default async function LegacyStorage(props: LegacyProps) {
  await legacyRedirect("storage", props);
}
