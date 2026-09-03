import { PageHeader } from "@/components/shared/page-header";

// Static header above the page's Suspense boundary, so it arrives with the shell
// instead of as a skeleton bar - and so the page has ONE name, refusal included.
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
