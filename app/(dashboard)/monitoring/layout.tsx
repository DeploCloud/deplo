import { PageHeader } from "@/components/shared/page-header";

// The header lives above the page's own Suspense boundary, so it arrives with the
// shell instead of being redrawn as skeleton bars by loading.tsx.
export default function MonitoringLayout(props: LayoutProps<"/monitoring">) {
  return (
    <div className="space-y-6">
      <PageHeader
        docs="monitoring.overview"
        title="Monitoring"
        description="Real-time CPU, memory, disk and network across your servers."
      />
      {props.children}
    </div>
  );
}
