import { PageHeader } from "@/components/shared/page-header";

// The header is static, so it belongs above the page's Suspense boundary: it
// arrives with the shell instead of being redrawn as a skeleton bar.
export default function ActivityLayout(props: LayoutProps<"/[team]/activity">) {
  return (
    <div className="space-y-2">
      <PageHeader
        docs="team.activity"
        title="Activity"
        description="A log of everything happening across your workspace."
      />
      {props.children}
    </div>
  );
}
