"use client";

import * as React from "react";
import Link from "@/components/ui/link";
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

export function AddNewMenu({
  canCreateApp,
  canCreateDatabase,
  canCreateFolder,
  canCreateProject,
  parentFolder = null,
  placement = null,
}: {
  canCreateApp: boolean;
  canCreateDatabase: boolean;
  canCreateFolder: boolean;
  canCreateProject: boolean;
  parentFolder?: { id: string; name: string } | null;
  placement?: OverviewPlacement | null;
}) {
  const [folderOpen, setFolderOpen] = React.useState(false);
  const [projectOpen, setProjectOpen] = React.useState(false);

  if (
    !canCreateApp &&
    !canCreateDatabase &&
    !canCreateFolder &&
    !canCreateProject
  )
    return (
      <Tooltip>
        <TooltipTrigger asChild>
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
            <DropdownMenuItem asChild>
              <Link href={newAppHref(placement)} className="cursor-pointer">
                <Rocket className="size-4" />
                Application
              </Link>
            </DropdownMenuItem>
          )}
          {canCreateDatabase && (
            <DropdownMenuItem asChild>
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
