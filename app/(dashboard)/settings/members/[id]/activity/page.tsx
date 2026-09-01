import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { hasCapability, reachesWholeTeam } from "@/lib/membership";
import { listMembers } from "@/lib/data/members";
import { listApps } from "@/lib/data/apps";
import { listDatabases } from "@/lib/data/databases";
import { listFolders } from "@/lib/data/folders";
import { listProjects } from "@/lib/data/projects";
import { UserAvatar } from "@/components/shared/user-avatar";
import { titleClass } from "@/components/shared/page-header";
import { DocsLink } from "@/components/ui/docs-link";
import { ScopedActivity } from "@/components/activity/scoped-activity";
import {
  toAppLinks,
  toDatabaseLinks,
} from "@/components/activity/activity-timeline";

export async function generateMetadata(
  props: PageProps<"/settings/members/[id]/activity">,
) {
  if (!(await hasCapability("manage_members"))) return { title: "Settings" };
  const { id } = await props.params;
  const member = (await listMembers()).find((m) => m.userId === id);
  return { title: member ? `Activity · @${member.username}` : "Activity" };
}

/**
 * The team's trail narrowed to ONE person - the same feed, filters and counts as
 * /activity with the User facet fixed to them and left out.
 */
export default async function MemberActivityPage(
  props: PageProps<"/settings/members/[id]/activity">,
) {
  if (!(await hasCapability("manage_members"))) notFound();
  const { id } = await props.params;

  // A database belongs to the team and to no project, so `listDatabases` refuses a
  // role that only reaches part of it - and such a role reaches no database row in
  // the feed either, so there is nothing to name.
  const [members, apps, folders, projects, teamWide] = await Promise.all([
    listMembers(),
    listApps(),
    listFolders(),
    listProjects(),
    reachesWholeTeam(),
  ]);
  const databases = teamWide ? await listDatabases() : [];

  const member = members.find((m) => m.userId === id);
  // Not a member of the team you are acting in: there is no id to guess your way
  // into, exactly as on the member page itself.
  if (!member) notFound();

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <Link
        href={`/settings/members/${id}`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />@{member.username}
      </Link>
      <header className="flex flex-wrap items-center gap-3">
        <UserAvatar
          name={member.name}
          username={member.username}
          avatarUrl={member.avatarUrl}
          size="xl"
        />
        <div className="min-w-0">
          <h1 className={titleClass.page}>@{member.username}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Everything {member.name || `@${member.username}`} has done in this
            team, newest first.
            <DocsLink topic="team.activity" className="ml-1.5" />
          </p>
        </div>
      </header>
      <ScopedActivity
        scope={{ kind: "actor", userId: id }}
        base={`/settings/members/${id}/activity`}
        searchParams={await props.searchParams}
        emptyDescription={`@${member.username} hasn't done anything in this team that gets logged.`}
        apps={apps}
        folders={folders}
        projects={projects}
        databases={databases}
        appLinks={toAppLinks(apps)}
        databaseLinks={toDatabaseLinks(databases)}
      />
    </div>
  );
}
