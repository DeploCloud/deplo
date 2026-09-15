import { legacyRedirect, type LegacyProps } from "@/lib/legacy-redirect";

export default async function LegacyLogs(props: LegacyProps) {
  await legacyRedirect("logs", props);
}
