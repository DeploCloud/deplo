import { HardDrive, PlugZap } from "lucide-react";

import { takeoverPreflight } from "@/lib/data/takeover";
import { formatBytes } from "@/lib/utils";

/**
 * The two things that otherwise only show up half way through a volume copy: a
 * disk with no room for a second copy, and an agent nobody can dial.
 */
export async function TakeoverPreflight() {
  const pre = await takeoverPreflight();
  if (!pre) return null;
  if (pre.agentReady && !pre.diskTight) return null;

  return (
    <div className="grid gap-2 rounded-lg border border-warning/40 bg-warning/[0.06] p-3">
      {!pre.agentReady && (
        <Line
          icon={<PlugZap className="mt-0.5 size-4 shrink-0 text-destructive" />}
          title="This machine's agent is not answering"
          body={`Deplo reads a volume by asking the agent standing on the disk that holds it, so nothing can be copied until it does. ${pre.agentMessage}`}
        />
      )}
      {pre.diskTight && (
        <Line
          icon={<HardDrive className="mt-0.5 size-4 shrink-0 text-warning" />}
          title={`${formatBytes(pre.diskFreeBytes)} free of ${formatBytes(pre.diskTotalBytes)}`}
          body="Every volume that comes across is written a second time before the old one goes, so the copy needs room for both. Free some space first, or bring fewer projects at a time."
        />
      )}
    </div>
  );
}

function Line({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex items-start gap-2">
      {icon}
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}
