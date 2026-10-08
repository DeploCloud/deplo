"use client";

import * as React from "react";
import { gql } from "@/lib/graphql-client";
import {
  detectionKey,
  type RepoAnalysis,
  type DeplopackOverride,
} from "@/lib/apps/deplopack-types";

export interface RepoAnalysisInput {
  repo: string;
  branch?: string;
  installationId?: string | null;
  connectionId?: string | null;
  serverId: string;
  buildServerId?: string | null;
  rootDirectory: string;
  folderId?: string | null;
  projectId?: string | null;
  environmentId?: string | null;
}
export function useRepoAnalysis(input: RepoAnalysisInput | null) {
  const key = input?.repo && input.serverId ? JSON.stringify(input) : null;
  const [attempt, setAttempt] = React.useState(0);
  const [answer, setAnswer] = React.useState<{
    key: string;
    analysis: RepoAnalysis | null;
    error: string | null;
  } | null>(null);
  const [selection, setSelection] = React.useState<{
    key: string;
    candidate: string;
    values: Record<string, string[]>;
  } | null>(null);
  const [expired, setExpired] = React.useState(false);
  React.useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    setAnswer(null);
    setSelection(null);
    setExpired(false);
    const timer = setTimeout(() => {
      void gql<{ analyzeRepo: RepoAnalysis }>(
        `query($repo:String!,$branch:String,$installationId:String,$connectionId:String,$serverId:String!,$buildServerId:String,$rootDirectory:String,$folderId:String,$projectId:String,$environmentId:String){analyzeRepo(repo:$repo,branch:$branch,installationId:$installationId,connectionId:$connectionId,serverId:$serverId,buildServerId:$buildServerId,rootDirectory:$rootDirectory,folderId:$folderId,projectId:$projectId,environmentId:$environmentId)}`,
        JSON.parse(key),
        controller.signal,
      )
        .then((data) => {
          if (!controller.signal.aborted)
            setAnswer({ key, analysis: data.analyzeRepo, error: null });
        })
        .catch((error) => {
          if (!controller.signal.aborted)
            setAnswer({
              key,
              analysis: null,
              error:
                error instanceof Error
                  ? error.message
                  : "Repository analysis failed",
            });
        });
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, attempt]);
  const analysis = answer?.key === key ? answer.analysis : null;
  React.useEffect(() => {
    if (!analysis) return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, analysis.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [analysis]);
  const candidates = analysis?.result.detections ?? [];
  const current = selection?.key === key ? selection : null;
  const selected =
    candidates.find(
      (candidate) => detectionKey(candidate) === current?.candidate,
    ) ??
    candidates[0] ??
    null;
  const values = current?.values ?? {};
  const overrides: DeplopackOverride[] = (selected?.inputs ?? []).flatMap(
    (field) => {
      const raw = values[field.env];
      if (!raw) return [];
      const nonempty = raw.filter((value) => value.trim() !== "");
      return nonempty.length
        ? [{ env: field.env, type: field.type, values: nonempty }]
        : [];
    },
  );
  const error = expired
    ? "Repository analysis expired. Analyze it again."
    : answer?.key === key
      ? answer.error
      : null;
  const detecting = Boolean(key) && answer?.key !== key;
  const ready = Boolean(
    analysis?.result.success && selected && !error && !detecting,
  );
  return {
    enabled: input !== null,
    analysis,
    selected,
    values,
    overrides,
    error,
    detecting,
    ready,
    select: (candidate: string) => {
      if (key) setSelection({ key, candidate, values: {} });
    },
    change: (env: string, next: string[]) => {
      if (key && selected)
        setSelection({
          key,
          candidate: detectionKey(selected),
          values: { ...values, [env]: next },
        });
    },
    reset: (env: string) => {
      if (key && selected) {
        const next = { ...values };
        delete next[env];
        setSelection({ key, candidate: detectionKey(selected), values: next });
      }
    },
    refresh: () => setAttempt((value) => value + 1),
  };
}
export type RepoAnalysisState = ReturnType<typeof useRepoAnalysis>;
