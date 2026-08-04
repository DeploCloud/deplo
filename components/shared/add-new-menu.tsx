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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CreateFolderDialog } from "@/components/apps/create-folder-dialog";
import { CreateProjectDialog } from "@/components/apps/create-project-dialog";
import { AddMemberDialog } from "@/components/members/add-member-dialog";
import { RegisterUserWizard } from "@/components/settings/users/register-user-wizard";
import {
  newAppHref,
  templatesHref,
  type OverviewPlacement,
} from "@/lib/overview-links";

/**
 * Overview "Add new" menu: a single entry point to create an app, a database, a
 * folder, a project, a team member, or (for instance admins) a global user. Each
 * creation flow reuses the same dialog component as its dedicated page, so
 * behaviour stays in sync.
 *
 * Every item is gated on exactly the capability its flow needs — an entry that
 * only leads to "you don't have permission" is not offered at all. A viewer who
 * holds none of them gets the button DISABLED, with a tooltip saying why, rather
 * than an empty menu.
 *
 * Creating a TEAM is deliberately not here: it belongs to the team switcher in
 * the topbar, which is where teams are chosen and left.
 */
export function AddNewMenu({
  canCreateApp,
  canCreateDatabase,
  canManageMembers,
  canCreateFolder,
  canCreateProject,
  isAdmin,
  parentFolder = null,
  placement = null,
}: {
  /** Whether the viewer may create apps (`create_apps`) — gates both the
   *  from-scratch wizard and the template catalogue, which only lead there. */
  canCreateApp: boolean;
  /** Whether the viewer may create databases (`create_databases`). */
  canCreateDatabase: boolean;
  canManageMembers: boolean;
  /** Whether the viewer may create folders (`create_folders`). */
  canCreateFolder: boolean;
  /** Whether the viewer may create projects (`create_projects`) — a separate
   *  permission from folders, so the two entries appear separately. */
  canCreateProject: boolean;
  isAdmin: boolean;
  /** The folder currently open on the Overview, if any. A folder created from
   *  this menu nests under it (ADR-0009: folders nest via `parentId`). Null at the
   *  top level, or inside a project — folders never live in a project, so one made
   *  there stays at the top level. Projects always create at the top level. */
  parentFolder?: { id: string; name: string } | null;
  /** The drill-in the menu was opened in (open folder, or project + selected
   *  environment). Carried into the app-creation flows so an app created from
   *  inside a folder is created IN it, not at the team top level. */
  placement?: OverviewPlacement | null;
}) {
  const [folderOpen, setFolderOpen] = React.useState(false);
  const [projectOpen, setProjectOpen] = React.useState(false);
  const [memberOpen, setMemberOpen] = React.useState(false);
  const [userOpen, setUserOpen] = React.useState(false);

  // Nothing this menu offers is available: show the button disabled with the
  // reason rather than a menu that opens onto nothing.
  if (
    !canCreateApp &&
    !canCreateDatabase &&
    !canCreateFolder &&
    !canCreateProject &&
    !canManageMembers &&
    !isAdmin
  )
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Disabled buttons swallow pointer events, so wrap in a focusable
              span to keep the tooltip reachable. */}
          <span tabIndex={0}>
            <Button size="sm" disabled>
              <Plus className="size-4" />
              Add New
              <ChevronDown className="size-3.5 opacity-70" />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          You don&apos;t have permission to create anything in this team
        </TooltipContent>
      </Tooltip>
    );

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
          {canCreateApp && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="cursor-pointer">
                <Rocket className="size-4" />
                New app
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem asChild>
                  <Link href={newAppHref(placement)} className="cursor-pointer">
                    <Sparkles className="size-4" />
                    From Scratch
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link
                    href={templatesHref(placement)}
                    className="cursor-pointer"
                  >
                    <LayoutTemplate className="size-4" />
                    From Template
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          {canCreateDatabase && (
            <DropdownMenuItem asChild>
              {/* Opens the create-database modal straight away on the Storage
                  page (the databases tab) via the ?new=database param. */}
              <Link href="/storage?new=database" className="cursor-pointer">
                <Database className="size-4" />
                New database
              </Link>
            </DropdownMenuItem>
          )}
          {canCreateFolder && (
            <DropdownMenuItem
              className="cursor-pointer"
              onSelect={() => setFolderOpen(true)}
            >
              <FolderPlus className="size-4" />
              {parentFolder ? "New subfolder" : "New folder"}
            </DropdownMenuItem>
          )}
          {canCreateProject && (
            <DropdownMenuItem
              className="cursor-pointer"
              onSelect={() => setProjectOpen(true)}
            >
              <Boxes className="size-4" />
              New project
            </DropdownMenuItem>
          )}

          {canManageMembers && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Team</DropdownMenuLabel>
              <DropdownMenuItem
                className="cursor-pointer"
                onSelect={() => setMemberOpen(true)}
              >
                <UserPlus className="size-4" />
                New team member
              </DropdownMenuItem>
            </>
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
      {canCreateProject && (
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
        <RegisterUserWizard open={userOpen} onOpenChange={setUserOpen} />
      )}
    </>
  );
}
