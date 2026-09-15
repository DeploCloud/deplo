"use client";

import {
  GitSourcePicker,
  type GitSourceValue,
} from "@/components/apps/git-source-picker";
import {
  GithubRepoPicker,
  type GithubSelection,
} from "@/components/apps/github-repo-picker";
import { ImageInput } from "@/components/apps/image-input";
import { UploadInput } from "@/components/apps/upload-input";
import { FieldLabel } from "@/components/ui/info-tip";
import type { GitConnectionDTO } from "@/lib/data/git-connections";
import type { GithubInstallationDTO } from "@/lib/data/github";
import type { DeploySource } from "@/lib/types/app";
import type { GitProviderChoice } from "@/lib/types/git";

import { nameFromArchive, nameFromImage } from "./source-hints";

export function SourceFields({
  source,
  isTemplate,
  installations,
  setSource,
  setGhSelection,
  suggestName,
  connections,
  providers,
  isInstanceAdmin,
  gitValue,
  onGitChange,
  dockerImage,
  setDockerImage,
  setImagePort,
  uploadFile,
  setUploadFile,
}: {
  source: DeploySource | null;
  isTemplate: boolean;
  installations: GithubInstallationDTO[];
  setSource: (next: DeploySource) => void;
  setGhSelection: (sel: GithubSelection | null) => void;
  suggestName: (suggested: string) => void;
  connections: GitConnectionDTO[];
  providers: GitProviderChoice[];
  isInstanceAdmin: boolean;
  gitValue: GitSourceValue;
  onGitChange: (value: GitSourceValue) => void;
  dockerImage: string;
  setDockerImage: (value: string) => void;
  setImagePort: (port: number | null) => void;
  uploadFile: File | null;
  setUploadFile: (file: File | null) => void;
}) {
  return (
    <>
      {source === "github" && (
        <GithubRepoPicker
          installations={installations}
          onUsePublicUrl={() => setSource("git")}
          onChange={(sel) => {
            setGhSelection(sel);
            if (sel) suggestName(sel.fullName.split("/")[1] ?? "");
          }}
        />
      )}

      {source === "git" && (
        <GitSourcePicker
          connections={connections}
          providers={providers}
          isInstanceAdmin={isInstanceAdmin}
          initial={{
            url: gitValue.url,
            repo: gitValue.repo,
            branch: gitValue.branch,
          }}
          onChange={onGitChange}
        />
      )}

      {source === "docker-image" && !isTemplate && (
        <div className="space-y-2">
          <FieldLabel
            htmlFor="image"
            info="Pulls a prebuilt image from any registry. No build step runs. Start typing to search."
            docs="deploy.dockerImage"
          >
            Docker image
          </FieldLabel>
          <ImageInput
            id="image"
            value={dockerImage}
            onChange={(v) => {
              setDockerImage(v);
              suggestName(nameFromImage(v));
            }}
            onPort={setImagePort}
          />
        </div>
      )}

      {source === "upload" && (
        <UploadInput
          file={uploadFile}
          onSelect={(file) => {
            setUploadFile(file);
            if (file) suggestName(nameFromArchive(file.name));
          }}
        />
      )}
    </>
  );
}
