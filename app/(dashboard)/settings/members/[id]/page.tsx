import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { getCurrentUser } from "@/lib/auth";
import { hasCapability } from "@/lib/membership";
import { listMembers } from "@/lib/data/members";
import { getMemberAccess } from "@/lib/data/user-access";
import { listRoles } from "@/lib/data/roles";
import { listTeamScopeTree } from "@/lib/data/tokens";
import { MemberDetailTabs } from "./member-detail-tabs";

export async function generateMetadata(
  props: PageProps<"/settings/members/[id]">,
) {
  if (!(await hasCapability("manage_members"))) return { title: "Settings" };
  const { id } = await props.params;
  const member = (await listMembers()).find((m) => m.userId === id);
  return { title: member ? `Settings · @${member.username}` : "Settings · Members" };
}

/**
 * One member's permissions and reach, in the team you are acting in.
 *
 * `manage_members` opens it, which is stricter than the roster beside it. The
 * Access tab names the folders someone was shared into, and a folder is private
 * to its owner and grantees (ADR-0016) — rendering this read-only to every
 * member would hand them the name of every private folder in the team.
 *
 * Everything the tabs need is read here and passed down: nothing fetches on
 * mount, which is the same contract the server detail page keeps.
 */
export default async function MemberPage(
  props: PageProps<"/settings/members/[id]">,
) {
  if (!(await hasCapability("manage_members"))) notFound();
  const { id } = await props.params;

  // The FULL role rows, not a stripped summary: the picker shows each role's
  // permission count and hides Owner from anyone who can't hand out the rank,
  // and both read fields a summary doesn't carry.
  const [viewer, members, access, roles, tree] = await Promise.all([
    getCurrentUser(),
    listMembers(),
    getMemberAccess(id),
    listRoles(),
    listTeamScopeTree(),
  ]);
  const member = members.find((m) => m.userId === id);
  // Not a member of the team you are acting in: there is no id to guess your
  // way into, exactly as on the role and token pages.
  if (!member || !access) notFound();

  // The VIEWER's rank, not the target's: only an owner may hand out the owner
  // role, and reading it off the member you are editing answered "is this person
  // already an owner", which is a different question.
  const viewerIsOwner = members.some(
    (m) => m.role === "owner" && m.userId === viewer?.id,
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
        member={member}
        access={access}
        roles={roles}
        tree={tree}
        canAssignOwner={viewerIsOwner}
      />
    </div>
  );
}
