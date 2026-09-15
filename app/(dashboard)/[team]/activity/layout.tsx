import { PageHeader } from "@/components/shared/page-header";

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
