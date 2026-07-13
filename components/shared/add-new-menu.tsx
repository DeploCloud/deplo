"use client";

import * as React from "react";
import Link from "next/link";
import {
  Plus,
  ChevronDown,
  Rocket,
  Sparkles,
  LayoutTemplate,
  FolderPlus,
  Boxes,
  Database,
  Users,
  UserPlus,
  UserCog,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { CreateTeamDialog } from "@/components/teams/create-team-dialog";
import { CreateFolderDialog } from "@/components/apps/create-folder-dialog";
import { CreateProjectDialog } from "@/components/apps/create-project-dialog";
import { AddMemberDialog } from "@/components/members/add-member-dialog";
import { RegisterUserDialog } from "@/components/settings/register-user-dialog";

/**
 * Overview "Add new" menu: a single entry point to create an app, a team, a
 * team member, or (for instance admins) a global user. Each creation flow reuses
 * the same dialog component as its dedicated page, so behaviour stays in sync.
 *
 * Items are gated to match the dedicated pages: adding a member needs the
 * `manage_members` capability, and registering a user is instance-admin only.
 * Creating an app or a team is available to everyone (a new team makes the
 * viewer its owner).
 */
export function AddNewMenu({
  canManageMembers,
  canCreateFolder,
  isAdmin,
  parentFolder = null,
}: {
  canManageMembers: boolean;
  /** Whether the viewer may create folders (has the deploy capability, or is an
   *  instance admin). */
  canCreateFolder: boolean;
  isAdmin: boolean;
  /** The folder currently open on the Overview, if any. A folder created from
   *  this menu nests under it (ADR-0009: folders nest via `parentId`). Null at the
   *  top level, or inside a project — folders never live in a project, so one made
   *  there stays at the top level. Projects always create at the top level. */
  parentFolder?: { id: string; name: string } | null;
}) {
  const [teamOpen, setTeamOpen] = React.useState(false);
  const [folderOpen, setFolderOpen] = React.useState(false);
  const [projectOpen, setProjectOpen] = React.useState(false);
  const [memberOpen, setMemberOpen] = React.useState(false);
  const [userOpen, setUserOpen] = React.useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm">
            <Plus className="size-4" />
            Add New
            <ChevronDown className="size-3.5 opacity-70" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="cursor-pointer">
              <Rocket className="size-4" />
              New app
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem asChild>
                <Link href="/new" className="cursor-pointer">
                  <Sparkles className="size-4" />
                  From Scratch
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/templates" className="cursor-pointer">
                  <LayoutTemplate className="size-4" />
                  From Template
                </Link>
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem asChild>
            {/* Opens the create-database modal straight away on the Storage
                page (the databases tab) via the ?new=database param. */}
            <Link href="/storage?new=database" className="cursor-pointer">
              <Database className="size-4" />
              New database
            </Link>
          </DropdownMenuItem>
          {canCreateFolder && (
            <DropdownMenuItem
              className="cursor-pointer"
              onSelect={() => setFolderOpen(true)}
            >
              <FolderPlus className="size-4" />
              {parentFolder ? "New subfolder" : "New folder"}
            </DropdownMenuItem>
          )}
          {canCreateFolder && (
            <DropdownMenuItem
              className="cursor-pointer"
              onSelect={() => setProjectOpen(true)}
            >
              <Boxes className="size-4" />
              New project
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />
          <DropdownMenuLabel>Team</DropdownMenuLabel>
          <DropdownMenuItem
            className="cursor-pointer"
            onSelect={() => setTeamOpen(true)}
          >
            <Users className="size-4" />
            New team
          </DropdownMenuItem>
          {canManageMembers && (
            <DropdownMenuItem
              className="cursor-pointer"
              onSelect={() => setMemberOpen(true)}
            >
              <UserPlus className="size-4" />
              New team member
            </DropdownMenuItem>
          )}

          {isAdmin && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Instance</DropdownMenuLabel>
              <DropdownMenuItem
                className="cursor-pointer"
                onSelect={() => setUserOpen(true)}
              >
                <UserCog className="size-4" />
                New user
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateTeamDialog open={teamOpen} onOpenChange={setTeamOpen} />
      {canCreateFolder && (
        <CreateFolderDialog
          open={folderOpen}
          onOpenChange={setFolderOpen}
          parentId={parentFolder?.id ?? null}
          description={
            parentFolder
              ? `This folder will be created inside “${parentFolder.name}”. Apps are moved into it afterward from the grid.`
              : undefined
          }
        />
      )}
      {canCreateFolder && (
        <CreateProjectDialog open={projectOpen} onOpenChange={setProjectOpen} />
      )}
      {canManageMembers && (
        <AddMemberDialog
          open={memberOpen}
          onOpenChange={setMemberOpen}
          canCreateUser={isAdmin}
          onCreateUser={() => setUserOpen(true)}
        />
      )}
      {isAdmin && (
        <RegisterUserDialog open={userOpen} onOpenChange={setUserOpen} />
      )}
    </>
  );
}
