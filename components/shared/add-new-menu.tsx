"use client";

import * as React from "react";
import Link from "next/link";
import {
  Plus,
  ChevronDown,
  Rocket,
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { CreateTeamDialog } from "@/components/teams/create-team-dialog";
import { AddMemberDialog } from "@/components/members/add-member-dialog";
import { RegisterUserDialog } from "@/components/settings/register-user-dialog";

/**
 * Overview "Add new" menu: a single entry point to create a project, a team, a
 * team member, or (for instance admins) a global user. Each creation flow reuses
 * the same dialog component as its dedicated page, so behaviour stays in sync.
 *
 * Items are gated to match the dedicated pages: adding a member needs the
 * `manage_members` capability, and registering a user is instance-admin only.
 * Creating a project or a team is available to everyone (a new team makes the
 * viewer its owner).
 */
export function AddNewMenu({
  canManageMembers,
  isAdmin,
}: {
  canManageMembers: boolean;
  isAdmin: boolean;
}) {
  const [teamOpen, setTeamOpen] = React.useState(false);
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
          <DropdownMenuItem asChild>
            <Link href="/new" className="cursor-pointer">
              <Rocket className="size-4" />
              New project
            </Link>
          </DropdownMenuItem>

          <DropdownMenuSeparator />
          <DropdownMenuLabel>Team</DropdownMenuLabel>
          <DropdownMenuItem
            className="cursor-pointer"
            onSelect={(e) => {
              e.preventDefault();
              setTeamOpen(true);
            }}
          >
            <Users className="size-4" />
            New team
          </DropdownMenuItem>
          {canManageMembers && (
            <DropdownMenuItem
              className="cursor-pointer"
              onSelect={(e) => {
                e.preventDefault();
                setMemberOpen(true);
              }}
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
                onSelect={(e) => {
                  e.preventDefault();
                  setUserOpen(true);
                }}
              >
                <UserCog className="size-4" />
                New user
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateTeamDialog open={teamOpen} onOpenChange={setTeamOpen} />
      {canManageMembers && (
        <AddMemberDialog open={memberOpen} onOpenChange={setMemberOpen} />
      )}
      {isAdmin && (
        <RegisterUserDialog open={userOpen} onOpenChange={setUserOpen} />
      )}
    </>
  );
}
