import { notFound } from "next/navigation";

import { logoSrc } from "@/lib/apps/logo-src";
import { getAppBySlug } from "@/lib/data/apps/listing";
import { AppActivityHeader } from "@/components/apps/app-tab-headers";
import { ScopedActivity } from "@/components/activity/scoped-activity";

export const metadata = { title: "Activity" };

export default async function AppActivityPage(
  props: PageProps<"/[team]/apps/[slug]/activity">,
) {
  const { slug } = await props.params;
  const app = await getAppBySlug(slug);
  if (!app) notFound();

  return (
    <div className="space-y-5">
      <AppActivityHeader />
      <ScopedActivity
        scope={{ kind: "resource", resourceId: app.id }}
        base={`/apps/${slug}/activity`}
        searchParams={await props.searchParams}
        emptyDescription="Every change made here shows up in this list."
        appLinks={{
          [app.id]: {
            name: app.name,
            slug,
            logo: logoSrc("app", app.id, app.logo),
          },
        }}
      />
    </div>
  );
}
