import { legacyRedirect, type LegacyProps } from "@/lib/legacy-redirect";

/** `/storage/...` before the team was in the address. */
export default async function LegacyStorage(props: LegacyProps) {
  await legacyRedirect("storage", props);
}
