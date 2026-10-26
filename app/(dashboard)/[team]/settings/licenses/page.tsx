import { redirect } from "next/navigation";

export default async function LicensesRedirect(
  props: PageProps<"/[team]/settings/licenses">,
) {
  const { team } = await props.params;
  const { license } = await props.searchParams;
  const keep =
    typeof license === "string"
      ? `&license=${encodeURIComponent(license)}`
      : "";
  redirect(`/${team}/settings/deplo?tab=about${keep}`);
}
