import { listRegistries } from "@/lib/data/registries";
import { RegistriesPanel } from "@/components/settings/registries-panel";

export const metadata = { title: "Settings · Registries" };

export default async function SettingsRegistriesPage() {
  const registries = await listRegistries();

  return <RegistriesPanel registries={registries} />;
}
