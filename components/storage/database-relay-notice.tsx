import { Info } from "lucide-react";
import { DocsLink } from "@/components/ui/docs-link";
import { databaseRelayNotice } from "@/lib/data/clusters/relay-notice";

// Shown when Apps on another server of the cluster reach this database through Deplo's relay.
export async function DatabaseRelayNotice({ id }: { id: string }) {
  const text = await databaseRelayNotice(id);
  if (!text) return null;
  return (
    <div className="flex items-start gap-2 rounded-xl border bg-muted p-3 text-sm">
      <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <p className="text-muted-foreground">
        {text} <DocsLink topic="clusters.privateNetwork" />
      </p>
    </div>
  );
}
