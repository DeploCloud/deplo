import { PageHeader } from "@/components/shared/page-header";
import { TemplatesBrowser } from "@/components/templates/templates-browser";
import { TEMPLATES, topTags } from "@/lib/templates";

export const metadata = { title: "Templates" };

export default function TemplatesPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Templates"
        description={`Deploy ${TEMPLATES.length} popular apps, databases and services to your servers in one click.`}
      />
      <TemplatesBrowser templates={TEMPLATES} tags={topTags(16)} />
    </div>
  );
}
