import { VariablesTabs } from "@/components/env/variables-tabs";
import { AllAppsEnvSkeleton } from "@/components/env/all-apps-env-manager";

// The manager marks itself aria-busy while loading.
export default function Loading() {
  return <VariablesTabs all={<AllAppsEnvSkeleton />} shared={null} />;
}
