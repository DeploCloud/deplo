import { ShieldCheck, TriangleAlert } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { DocsLink } from "@/components/ui/docs-link";
import Link from "@/components/ui/link";
import { WaitingForRoom } from "@/components/shared/waiting-for-room";
import type {
  DatabaseFailover,
  FailoverPreview,
} from "@/lib/data/databases/failover";

/** The promises of spec #176, in its words, wherever failover is described. */
export function FailoverPromises({
  promises,
}: {
  promises: readonly string[];
}) {
  return (
    <ul className="space-y-1 text-sm">
      {promises.map((p) => (
        <li key={p} className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span>{p}</span>
        </li>
      ))}
    </ul>
  );
}

/** What a database on a cluster relies on: the two promises, then loss and recovery. */
export function FailoverNote({ promises, loss, recovery }: FailoverPreview) {
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <FailoverPromises promises={promises} />
      <p className="text-xs text-muted-foreground">
        {loss} {recovery} <DocsLink topic="clusters.databases" />
      </p>
    </div>
  );
}

export function DatabaseFailoverCard({
  failover,
  backupsHref,
}: {
  failover: DatabaseFailover;
  backupsHref?: string;
}) {
  return (
    <div className="space-y-3">
      {failover.warning && (
        <div className="flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning-wash-strong px-4 py-3 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
          <p>
            {failover.warning}
            {backupsHref && (
              <>
                {" "}
                <Link
                  href={backupsHref}
                  className="font-medium underline underline-offset-2 hover:no-underline"
                >
                  Backups
                </Link>
              </>
            )}
          </p>
        </div>
      )}
      <Card>
        <CardContent className="space-y-3 pt-6">
          <div>
            <p className="text-sm font-medium">Failover</p>
            {failover.waiting && (
              <p className="mt-1">
                <WaitingForRoom note={failover.waiting} />
              </p>
            )}
            <p className="mt-1 text-sm text-muted-foreground">
              Runs on cluster {failover.cluster}, now on {failover.serverName}.
              {failover.destination && ` Backed up to ${failover.destination}.`}
              {failover.standbyOn &&
                ` Its standby copy runs on ${failover.standbyOn}.`}
            </p>
            {failover.standbyNote && (
              <p className="mt-1 text-sm text-muted-foreground">
                {failover.standbyNote}
              </p>
            )}
          </div>
          <FailoverNote
            promises={failover.promises}
            loss={failover.loss}
            recovery={failover.recovery}
          />
        </CardContent>
      </Card>
    </div>
  );
}
