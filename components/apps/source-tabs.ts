import { GitBranch, Container, Upload, FileText } from "lucide-react";
import type * as React from "react";

import { GitHubIcon } from "@/components/shared/brand-icons";
import type { DeploySource } from "@/lib/types";

export interface SourceTab {
  id: DeploySource;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** One line saying what this source IS, for the wizard's picker tiles. */
  blurb: string;
}

/** The five deploy sources, in the order both the wizard and app settings show
 *  them. One list, so a rename can never disagree between the two. */
export const SOURCE_TABS: SourceTab[] = [
  {
    id: "github",
    label: "GitHub",
    icon: GitHubIcon,
    blurb: "Pick a repository and deploy on every push.",
  },
  {
    id: "git",
    label: "Git",
    icon: GitBranch,
    blurb: "GitLab, Bitbucket, Gitea or any git server.",
  },
  {
    id: "docker-image",
    label: "Docker Image",
    icon: Container,
    blurb: "Run an image that is already built.",
  },
  {
    id: "upload",
    label: "Upload",
    icon: Upload,
    blurb: "Send a zip or tarball of your code.",
  },
  {
    id: "compose",
    label: "Compose",
    icon: FileText,
    blurb: "Bring up a docker-compose stack as written.",
  },
];

export function sourceLabelFor(source: DeploySource): string {
  return SOURCE_TABS.find((t) => t.id === source)?.label ?? source;
}
