"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import {
  UserPlus,
  UserCog,
  ChevronRight,
  Crown,
  FolderTree,
  KeyRound,
  ShieldCheck,
} from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { UserAvatar } from "@/components/shared/user-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AddMemberDialog } from "@/components/members/add-member-dialog";
import { RegisterUserWizard } from "@/components/settings/users/register-user-wizard";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { AccessDeltaBadge } from "@/components/members/access-delta-badge";
import { ListToolbar, type ListView } from "@/components/shared/list-toolbar";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/shared/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { MemberDTO } from "@/lib/data/members/roster";

export function MembersManager({
  members,
  currentUserId,
  canManage,
  isAdmin = false,
}: {
  members: MemberDTO[];
  currentUserId: string;
  canManage: boolean;
  isAdmin?: boolean;
}) {
  const [addOpen, setAddOpen] = React.useState(false);
  const [userOpen, setUserOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [role, setRole] = React.useState("all");
  const [view, setView] = React.useState<ListView>("grid");
  const viewerIsOwner = members.some(
    (m) => m.userId === currentUserId && m.role === "owner",
  );

  const roleNames = [
    ...new Set(members.map((m) => m.roleName ?? "Custom")),
  ].sort();
  const q = query.trim().toLowerCase();
  const shown = members.filter(
    (m) =>
      (role === "all" || (m.roleName ?? "Custom") === role) &&
      (!q ||
        m.username.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q)),
  );
  const actions = (isAdmin || canManage) && (
    <>
      {isAdmin && (
        <Button variant="outline" size="sm" asChild>
          <Link href="/settings/users">
            <UserCog className="size-4" />
            Manage users
          </Link>
        </Button>
      )}
      {canManage && (
        <>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <UserPlus className="size-4" />
            Add member
          </Button>
          <AddMemberDialog
            open={addOpen}
            onOpenChange={setAddOpen}
            canCreateUser={isAdmin}
            canAssignOwner={viewerIsOwner}
            onCreateUser={() => setUserOpen(true)}
          />
          {isAdmin && (
            <RegisterUserWizard open={userOpen} onOpenChange={setUserOpen} />
          )}
        </>
      )}
    </>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        docs="team.members"
        title={
          <span className="flex items-center gap-2">
            Members
            <Badge variant="secondary" className="tabular-nums">
              {members.length}
            </Badge>
          </span>
        }
        description="People who can access this team's apps and resources."
        actions={actions}
      />
      {members.length > 1 && (
        <ListToolbar
          query={query}
          onQuery={setQuery}
          placeholder="Search members"
          view={view}
          onView={setView}
          listLabel="Table view"
          filters={
            roleNames.length > 1 && (
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger className="w-full sm:w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All roles</SelectItem>
                  {roleNames.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )
          }
        />
      )}

      {shown.length === 0 ? (
        <EmptyState
          icon={UserCog}
          title="No matching members"
          description="Nobody in this team matches the current search and filter."
        />
      ) : view === "grid" ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((m) => (
            <MemberCard
              key={m.userId}
              member={m}
              isSelf={m.userId === currentUserId}
              canManage={canManage}
            />
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Access</TableHead>
                <TableHead className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((m) => (
                <MemberTableRow
                  key={m.userId}
                  member={m}
                  isSelf={m.userId === currentUserId}
                  canManage={canManage}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function MemberTableRow({
  member,
  isSelf,
  canManage,
}: {
  member: MemberDTO;
  isSelf: boolean;
  canManage: boolean;
}) {
  const granted = member.capabilities.filter((c) => c !== "view").length;
  const name = (
    <span className="flex min-w-0 items-center gap-2">
      <UserAvatar
        name={member.name}
        username={member.username}
        avatarUrl={member.avatarUrl}
      />
      <span className="truncate font-medium">@{member.username}</span>
      {member.isPrimaryOwner && (
        <SimpleTooltip content="Primary owner - created this team; can't be removed or demoted">
          <Crown className="size-3.5 shrink-0 text-amber-500" />
        </SimpleTooltip>
      )}
      {member.isInstanceAdmin && (
        <SimpleTooltip content="Instance admin - platform-wide administrator">
          <ShieldCheck className="size-3.5 shrink-0 text-sky-500" />
        </SimpleTooltip>
      )}
      {isSelf && <span className="text-xs text-muted-foreground">(you)</span>}
    </span>
  );
  return (
    <TableRow>
      <TableCell>
        {canManage ? (
          <Link
            href={`/settings/members/${member.userId}`}
            className="rounded focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            aria-label={`Manage @${member.username}`}
          >
            {name}
          </Link>
        ) : (
          name
        )}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {member.name && member.name !== member.username ? member.name : "—"}
      </TableCell>
      <TableCell>
        {member.isPrimaryOwner ? (
          <Badge className="gap-1 border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <Crown className="size-3" />
            Primary owner
          </Badge>
        ) : (
          <Badge variant="outline">{member.roleName ?? "Custom"}</Badge>
        )}
      </TableCell>
      <TableCell>
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">
            {granted === 0
              ? "View only"
              : `${granted} permission${granted === 1 ? "" : "s"}`}
          </Badge>
          {member.roleScoped && (
            <SimpleTooltip
              content={`Their ${member.roleName ?? "assigned"} role only reaches part of this team`}
            >
              <Badge variant="outline" className="gap-1">
                <FolderTree className="size-3" />
                Limited access
              </Badge>
            </SimpleTooltip>
          )}
          <AccessDeltaBadge
            delta={member.accessDelta}
            roleName={member.roleName}
          />
          <TokenCountBadge member={member} />
        </span>
      </TableCell>
      <TableCell className="text-right">
        {canManage && (
          <Button variant="ghost" size="icon-sm" asChild>
            <Link
              href={`/settings/members/${member.userId}`}
              aria-label={`Manage @${member.username}`}
            >
              <ChevronRight className="size-4" />
            </Link>
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

function MemberCard({
  member,
  isSelf,
  canManage,
}: {
  member: MemberDTO;
  isSelf: boolean;
  canManage: boolean;
}) {
  const isFounder = member.isPrimaryOwner;
  const granted = member.capabilities.filter((c) => c !== "view").length;

  const inner = (
    <div className="flex h-full flex-col gap-3 rounded-lg border border-border p-4 transition-colors group-hover:border-foreground/20">
      <div className="flex w-full items-center gap-3">
        <UserAvatar
          name={member.name}
          username={member.username}
          avatarUrl={member.avatarUrl}
          size="lg"
        />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1 text-sm font-medium">
            <span className="truncate">@{member.username}</span>
            {isFounder && (
              <SimpleTooltip content="Primary owner - created this team; can't be removed or demoted">
                <span className="shrink-0 leading-none">
                  <Crown
                    className="size-3.5 text-amber-500"
                    aria-label="Primary owner"
                  />
                </span>
              </SimpleTooltip>
            )}
            {member.isInstanceAdmin && (
              <SimpleTooltip content="Instance admin - platform-wide administrator">
                <span className="shrink-0 leading-none">
                  <ShieldCheck
                    className="size-3.5 text-sky-500"
                    aria-label="Instance admin"
                  />
                </span>
              </SimpleTooltip>
            )}
            {isSelf && (
              <span className="ml-0.5 shrink-0 text-xs text-muted-foreground">
                (you)
              </span>
            )}
          </p>
          {member.name && member.name !== member.username && (
            <p className="truncate text-xs text-muted-foreground">
              {member.name}
            </p>
          )}
        </div>
        {canManage && (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {isFounder ? (
          <Badge className="gap-1 border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <Crown className="size-3" />
            Primary owner
          </Badge>
        ) : (
          <Badge variant="outline">{member.roleName ?? "Custom"}</Badge>
        )}
        <Badge variant="outline">
          {granted === 0
            ? "View only"
            : `${granted} permission${granted === 1 ? "" : "s"}`}
        </Badge>
        {member.roleScoped && (
          <SimpleTooltip
            content={`Their ${member.roleName ?? "assigned"} role only reaches part of this team`}
          >
            <Badge variant="outline" className="gap-1">
              <FolderTree className="size-3" />
              Limited access
            </Badge>
          </SimpleTooltip>
        )}
        <AccessDeltaBadge
          delta={member.accessDelta}
          roleName={member.roleName}
        />
      </div>
    </div>
  );

  if (!canManage) return inner;

  return (
    <Link
      href={`/settings/members/${member.userId}`}
      className="group block h-full rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      aria-label={`Manage @${member.username}`}
    >
      {inner}
    </Link>
  );
}

function TokenCountBadge({ member }: { member: MemberDTO }) {
  if (member.tokenCount === 0) return null;
  const tokens = `${member.tokenCount} token${member.tokenCount === 1 ? "" : "s"}`;
  const agents = member.agentCount
    ? ` · ${member.agentCount} agent${member.agentCount === 1 ? "" : "s"}`
    : "";
  return (
    <SimpleTooltip content="Personal API tokens of theirs that can act in this team. Remove the member, or take away their API tokens or AI agents permission, to cut them off.">
      <Badge variant="outline" className="gap-1">
        <KeyRound className="size-3" />
        {tokens}
        {agents}
      </Badge>
    </SimpleTooltip>
  );
}
