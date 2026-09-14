import { GitBranch, Container, Upload, Boxes } from "lucide-react";
import type * as React from "react";

import { GitHubIcon } from "@/components/shared/brand-icons";
import type { LogoAccent } from "@/lib/templates/logo-color";
import type { DeploySource } from "@/lib/types/app";

export interface SourceTab {
  id: DeploySource;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  blurb: string;
  // Literal hexes, not tokens: a brand colour is not themeable.
  brand: { bg: string; fg: string };
  veil: LogoAccent;
}

// SOURCE_TABS - the five deploy sources, in the order the wizard and settings show them.
export const SOURCE_TABS: SourceTab[] = [
  {
    id: "github",
    label: "GitHub",
    icon: GitHubIcon,
    blurb: "Deploy a repository on every push.",
    brand: { bg: "#181717", fg: "#FFFFFF" },
    veil: { tone: "dark" },
  },
  {
    id: "git",
    label: "Git",
    icon: GitBranch,
    blurb: "GitLab, Bitbucket, Gitea or any git server.",
    brand: { bg: "#F05032", fg: "#FFFFFF" },
    veil: { hue: 33 },
  },
  {
    id: "docker-image",
    label: "Docker Image",
    icon: Container,
    blurb: "Run an image that is already built.",
    brand: { bg: "#2496ED", fg: "#FFFFFF" },
    veil: { hue: 248 },
  },
  {
    id: "compose",
    label: "Compose",
    icon: Boxes,
    blurb: "Bring up a docker-compose stack as written.",
    brand: { bg: "#50E3C2", fg: "#0A0A0A" },
    veil: { hue: 175 },
  },
  {
    id: "upload",
    label: "Upload",
    icon: Upload,
    blurb: "Send a zip or tarball of your code.",
    brand: { bg: "#8B5CF6", fg: "#FFFFFF" },
    veil: { hue: 293 },
  },
];

export function sourceLabelFor(source: DeploySource): string {
  return SOURCE_TABS.find((t) => t.id === source)?.label ?? source;
}
