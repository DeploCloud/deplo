import { Loader2 } from "lucide-react";
import { Bone } from "@/components/ui/skeleton";
import { titleClass } from "@/components/shared/page-header";

// The App Deployments tab heading; without counts it is the loading state's.
export function DeploymentHistoryHeader({
  total,
  inProgress = 0,
}: {
  total?: number;
  inProgress?: number;
}) {
  return (
    <div className="space-y-1">
      <h2 className={titleClass.section}>Deployment history</h2>
      <p className="text-sm text-muted-foreground">
        {total === undefined ? <Bone>24 total</Bone> : `${total} total`}
        {inProgress > 0 && (
          <>
            {" · "}
            <span className="inline-flex items-center gap-1 text-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {inProgress} in progress
            </span>
          </>
        )}
      </p>
    </div>
  );
}
