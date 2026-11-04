import { PageHeader } from "@/components/shared/page-header";

// Tab headings the page and its loading state both draw.
export function AppMonitoringHeader({ actions }: { actions: React.ReactNode }) {
  return (
    <PageHeader
      level="section"
      docs="monitoring.overview"
      title="Monitoring"
      description="Real-time CPU, memory, network and disk I/O for this app's containers."
      actions={actions}
    />
  );
}

export function AppActivityHeader() {
  return (
    <PageHeader
      level="section"
      title="Activity"
      docs="team.activity"
      description="Everything that happened to this app, newest first."
    />
  );
}
