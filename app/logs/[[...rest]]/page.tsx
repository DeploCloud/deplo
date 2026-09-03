import { legacyRedirect, type LegacyProps } from "@/lib/legacy-redirect";

/** `/logs/...` before the team was in the address. */
export default async function LegacyLogs(props: LegacyProps) {
  await legacyRedirect("logs", props);
}
