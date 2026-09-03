import { listRegistries } from "@/lib/data/registries";
import { RegistriesPanel } from "@/components/settings/registries-panel";

export const metadata = { title: "Settings · Registries" };

export default async function SettingsRegistriesPage() {
  const registries = await listRegistries();

  // The page header lives inside the panel: its Add button and the dialog it
  // opens are one interaction, so they have to share state.
  return <RegistriesPanel registries={registries} />;
}
