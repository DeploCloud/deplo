import { listRegistries } from "@/lib/data/registries";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/shared/page-header";
import { RegistriesPanel } from "@/components/settings/registries-panel";

export const metadata = { title: "Settings · Registries" };

export default async function SettingsRegistriesPage() {
  const registries = await listRegistries();

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            Registries
            <Badge variant="info" className="font-normal">
              Beta
            </Badge>
          </span>
        }
        description="Container image registries used to pull and push images."
      />
      <RegistriesPanel registries={registries} />
    </div>
  );
}
