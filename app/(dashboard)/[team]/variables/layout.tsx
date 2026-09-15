import { PageHeader } from "@/components/shared/page-header";

export default function VariablesLayout(
  props: LayoutProps<"/[team]/variables">,
) {
  return (
    <div className="space-y-6">
      <PageHeader
        docs="env.allApps"
        title="Environment Variables"
        description="Per-app variables and reusable shared variables across your workspace."
      />
      {props.children}
    </div>
  );
}
