import { FlaskConical } from "lucide-react";

import { Button } from "@/components/ui/button";
import Link from "@/components/ui/link";
import { EmptyState } from "@/components/shared/empty-state";
import { isInstanceAdmin } from "@/lib/membership";
import { EXPERIMENT_META, type ExperimentKey } from "@/lib/experiments";

// What a page of a feature shows while its experiment is off.
export async function ExperimentOff({
  experiment,
}: {
  experiment: ExperimentKey;
}) {
  const admin = await isInstanceAdmin();
  return (
    <EmptyState
      icon={FlaskConical}
      title={`${EXPERIMENT_META[experiment].label} are not turned on for this Deplo`}
      description={
        admin
          ? "Turn them on in Experiments to offer them to every team."
          : "An instance admin can turn them on."
      }
      docs="instance.experiments"
      action={
        admin && (
          <Button asChild variant="outline">
            <Link href="/settings/deplo?tab=experiments">Open Experiments</Link>
          </Button>
        )
      }
    />
  );
}
