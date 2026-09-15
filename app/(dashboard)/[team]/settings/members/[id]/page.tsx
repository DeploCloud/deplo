import { Suspense } from "react";
import Link from "@/components/ui/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { getCurrentUser } from "@/lib/auth/current-user";
import {
  hasCapability,
  isInstanceAdmin,
  reachesWholeTeam,
} from "@/lib/membership";
import { listMembers } from "@/lib/data/members/roster";
import { getMemberAccess } from "@/lib/data/user-access";
import { listRoles } from "@/lib/data/roles/role-list";
import { listTeamScopeTree } from "@/lib/data/tokens/scope-tree";
import { listApps } from "@/lib/data/apps/listing";
import { listDatabases } from "@/lib/data/databases/rows";
import { listFolders } from "@/lib/data/folders";
import { listProjects } from "@/lib/data/projects/read";
import { ScopedActivity } from "@/components/activity/scoped-activity";
import { ActivitySkeleton } from "@/components/activity/activity-skeleton";
import {
  toAppLinks,
  toDatabaseLinks,
} from "@/components/activity/activity-timeline";
import { MemberDetailTabs } from "./member-detail-tabs";

export async function generateMetadata(
  props: PageProps<"/[team]/settings/members/[id]">,
) {
  if (!(await hasCapability("manage_members"))) return { title: "Settings" };
  const { id } = await props.params;
  const member = (await listMembers()).find((m) => m.userId === id);
  return {
    title: member ? `Settings · @${member.username}` : "Settings · Members",
  };
}

export default async function MemberPage(
  props: PageProps<"/[team]/settings/members/[id]">,
) {
  if (!(await hasCapability("manage_members"))) notFound();
  const { id } = await props.params;

  const [viewer, members, access, roles, tree, isAdmin] = await Promise.all([
    getCurrentUser(),
    listMembers(),
    getMemberAccess(id),
    listRoles(),
    listTeamScopeTree(),
    isInstanceAdmin(),
  ]);
  const member = members.find((m) => m.userId === id);
  if (!member || !access) notFound();

  const viewerIsOwner = members.some(
    (m) => m.role === "owner" && m.userId === viewer?.id,
  );
  const viewerIsPrimaryOwner = members.some(
    (m) => m.isPrimaryOwner && m.userId === viewer?.id,
  );

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <Link
        href="/settings/members"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Members
      </Link>
      <MemberDetailTabs
        activity={
          <Suspense fallback={<ActivitySkeleton />}>
            <MemberActivity
              userId={id}
              username={member.username}
              searchParams={await props.searchParams}
            />
          </Suspense>
        }
        member={member}
        access={access}
        roles={roles}
        tree={tree}
        canAssignOwner={viewerIsOwner}
        isSelf={viewer?.id === member.userId}
        canManageAccount={isAdmin}
        viewerIsPrimaryOwner={viewerIsPrimaryOwner}
        viewerTwoFactorEnabled={viewer?.twoFactorEnabled ?? false}
      />
    </div>
  );
}

async function MemberActivity({
  userId,
  username,
  searchParams,
}: {
  userId: string;
  username: string;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const [apps, folders, projects, teamWide] = await Promise.all([
    listApps(),
    listFolders(),
    listProjects(),
    reachesWholeTeam(),
  ]);
  const databases = teamWide ? await listDatabases() : [];

  return (
    <ScopedActivity
      scope={{ kind: "actor", userId }}
      base={`/settings/members/${userId}?tab=activity`}
      searchParams={searchParams}
      emptyDescription={`@${username} hasn't done anything in this team that gets logged.`}
      apps={apps}
      folders={folders}
      projects={projects}
      databases={databases}
      appLinks={toAppLinks(apps)}
      databaseLinks={toDatabaseLinks(databases)}
    />
  );
}
