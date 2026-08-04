import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Ban, Crown, ShieldCheck } from "lucide-react";

import { getCurrentUser } from "@/lib/auth";
import { isInstanceAdmin } from "@/lib/membership";
import { getUserDetail } from "@/lib/data/members";
import { viewerIsInstanceOwner } from "@/lib/data/instance-owner";
import {
  listJoinableTeams,
  listRoleOptions,
  listUserAccess,
  listUserAccessTree,
  listUserActivity,
} from "@/lib/data/user-access";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/shared/page-header";
import { UserActivityCard } from "@/components/settings/users/user-activity-card";
import { UserEditor } from "@/components/settings/users/user-editor";

export async function generateMetadata(
  props: PageProps<"/settings/users/[id]">,
) {
  const { id } = await props.params;
  if (!(await isInstanceAdmin())) return { title: "Settings · Users" };
  const user = await getUserDetail(id);
  return { title: user ? `Settings · @${user.username}` : "Settings · Users" };
}

export default async function UserPage(props: PageProps<"/settings/users/[id]">) {
  const { id } = await props.params;
  // Not a 403: an admin-only area answers a non-admin exactly what a wrong URL
  // answers, so the page is never an oracle for which accounts exist.
  if (!(await isInstanceAdmin())) notFound();

  const [user, access, tree, activity, joinable, viewer, viewerIsOwner] =
    await Promise.all([
      getUserDetail(id),
      listUserAccess(id),
      listUserAccessTree(id),
      listUserActivity(id, 10),
      listJoinableTeams(id),
      getCurrentUser(),
      viewerIsInstanceOwner(),
    ]);
  if (!user) notFound();
  const roles = await listRoleOptions(access.map((a) => a.teamId));

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
          title={
            <span className="flex flex-wrap items-center gap-2">
              <Avatar className="size-8 shrink-0">
                <AvatarFallback
                  style={{ backgroundColor: user.avatarColor, color: "#000" }}
                >
                  {user.username.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              @{user.username}
              {user.isInstanceOwner ? (
                <Badge variant="secondary" className="gap-1 px-1.5 py-0">
                  <Crown className="size-3" />
                  Owner
                </Badge>
              ) : (
                user.isInstanceAdmin && (
                  <Badge variant="secondary" className="gap-1 px-1.5 py-0">
                    <ShieldCheck className="size-3" />
                    Admin
                  </Badge>
                )
              )}
              {user.suspended && (
                <Badge variant="destructive" className="gap-1 px-1.5 py-0">
                  <Ban className="size-3" />
                  Suspended
                </Badge>
              )}
            </span>
          }
          description={
            <>
              {user.name && user.name !== user.username ? `${user.name} · ` : ""}
              {user.email}
            </>
          }
        />
      </div>

      <UserEditor
        user={user}
        access={access}
        roles={roles}
        tree={tree}
        joinable={joinable}
        activity={<UserActivityCard activity={activity} />}
        isSelf={viewer?.id === user.userId}
        viewerIsOwner={viewerIsOwner}
      />
    </div>
  );
}
