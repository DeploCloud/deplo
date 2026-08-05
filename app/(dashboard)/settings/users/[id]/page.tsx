import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { isInstanceAdmin } from "@/lib/membership";
import { getUserDetail } from "@/lib/data/members";
import {
  listTeamRoleOptions,
  listUserAccess,
  listUserAccessTree,
} from "@/lib/data/user-access";
import { PageHeader } from "@/components/shared/page-header";
import { UserAccessEditor } from "@/components/settings/users/user-access-editor";
import type { TeamRoleOption } from "@/lib/data/user-access";

export async function generateMetadata(
  props: PageProps<"/settings/users/[id]">,
) {
  if (!(await isInstanceAdmin())) return { title: "Settings" };
  const { id } = await props.params;
  const user = await getUserDetail(id).catch(() => null);
  return { title: user ? `Settings · @${user.username}` : "Settings · Users" };
}

/**
 * One person's access across the instance: which team, which role, and which
 * projects, folders or apps they hold something different in.
 *
 * The write it drives (`setUserTeamAccess`) is instance-admin only on purpose:
 * an admin answering "who can touch Prod?" is by definition looking at teams
 * they may not belong to. What a team can do about its OWN members stays on the
 * team's Members page.
 */
export default async function UserAccessPage(
  props: PageProps<"/settings/users/[id]">,
) {
  if (!(await isInstanceAdmin())) notFound();
  const { id } = await props.params;

  // A user id that isn't one resolves to nothing here, exactly as it does in the
  // data layer: there is no id to guess your way into.
  const user = await getUserDetail(id).catch(() => null);
  if (!user) notFound();

  const [access, tree] = await Promise.all([
    listUserAccess(id),
    listUserAccessTree(id),
  ]);
  const roleLists = await Promise.all(
    access.map((a) => listTeamRoleOptions(a.teamId)),
  );
  const roleOptions: Record<string, TeamRoleOption[]> = {};
  access.forEach((a, i) => {
    roleOptions[a.teamId] = roleLists[i];
  });

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/settings/users"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          All users
        </Link>
        <PageHeader
          title={`@${user.username}`}
          description="What they can do in each team, down to a single project, folder or app."
        />
      </div>
      <UserAccessEditor
        userId={user.userId}
        username={user.username}
        access={access}
        tree={tree}
        roleOptions={roleOptions}
      />
    </div>
  );
}
