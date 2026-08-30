"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import Link from "next/link";
import {
  Plus,
  ChevronDown,
  Rocket,
  FolderPlus,
  Boxes,
  Database,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { newAppHref, type OverviewPlacement } from "@/lib/overview-links";

/**
 * Overview "Add new" menu: a single entry point to create an app, a database, a
 * folder, a project, a team member, or (for instance admins) a global user.
 */
export function AddNewMenu({
  canCreateApp,
  canCreateDatabase,
  canCreateFolder,
  canCreateProject,
  parentFolder = null,
  placement = null,
}: {
  /** Whether the viewer may create apps (`create_apps`) - gates both the
   *  from-scratch wizard and the template catalogue, which only lead there. */
  canCreateApp: boolean;
  /** Whether the viewer may create databases (`create_databases`). */
  canCreateDatabase: boolean;
  /** Whether the viewer may create folders (`create_folders`). */
  canCreateFolder: boolean;
  /** Whether the viewer may create projects (`create_projects`) - a separate
   *  permission from folders, so the two entries appear separately. */
  canCreateProject: boolean;
  /**
   * The folder currently open on the Overview, if any. Null at the top level, or
   * inside a project - folders never live in a project, so one made there stays at
   * the top level.
   */
  parentFolder?: { id: string; name: string } | null;
  /** The drill-in the menu was opened in (open folder, or project + selected
   *  environment). Carried into the app-creation flows so an app created from
   *  inside a folder is created IN it, not at the team top level. */
  placement?: OverviewPlacement | null;
}) {
  const [folderOpen, setFolderOpen] = React.useState(false);
  const [projectOpen, setProjectOpen] = React.useState(false);

  // Nothing this menu offers is available: show the button disabled with the
  // reason rather than a menu that opens onto nothing.
  if (
    !canCreateApp &&
    !canCreateDatabase &&
    !canCreateFolder &&
    !canCreateProject
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
          {/* Flat, not a submenu: the fork it used to ask about is the wizard's
              own first step, which offers the five sources AND the catalogue. */}
          {canCreateApp && (
            <DropdownMenuItem asChild>
              <Link href={newAppHref(placement)} className="cursor-pointer">
                <Rocket className="size-4" />
                Application
              </Link>
            </DropdownMenuItem>
          )}
          {canCreateDatabase && (
            <DropdownMenuItem asChild>
              {/* Opens the create-database modal straight away on the Storage
                  page (the databases tab) via the ?new=database param. */}
              <Link href="/storage?new=database" className="cursor-pointer">
                <Database className="size-4" />
                Database
              </Link>
            </DropdownMenuItem>
          )}
          {canCreateFolder && (
            <DropdownMenuItem
              className="cursor-pointer"
              onSelect={() => setFolderOpen(true)}
            >
              <FolderPlus className="size-4" />
              {parentFolder ? "Subfolder" : "Folder"}
            </DropdownMenuItem>
          )}
          {canCreateProject && (
            <DropdownMenuItem
              className="cursor-pointer"
              onSelect={() => setProjectOpen(true)}
            >
              <Boxes className="size-4" />
              Project
            </DropdownMenuItem>
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
    </>
  );
}
