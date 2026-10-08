"use client";

import { Plus, X, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AdvancedGroup } from "@/components/apps/wizard/advanced-section";
import { detectionKey } from "@/lib/apps/deplopack-types";
import type { RepoAnalysisState } from "./use-repo-analysis";

export function DeplopackDetections({ state }: { state: RepoAnalysisState }) {
  if (state.detecting)
    return (
      <div className="h-20 animate-pulse rounded-lg bg-muted" role="status">
        Analyzing repository…
      </div>
    );
  if (state.error)
    return (
      <div
        className="space-y-2 rounded-lg border border-destructive p-3"
        role="alert"
      >
        <p>{state.error}</p>
        <Button type="button" variant="outline" onClick={state.refresh}>
          Analyze again
        </Button>
      </div>
    );
  if (!state.analysis) return null;
  const { result } = state.analysis;
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">Detected in your repository</p>
      {!result.success && (
        <p className="text-sm text-destructive">
          Repository analysis failed. Review the errors and analyze again.
        </p>
      )}
      {!result.detections.length && (
        <p className="text-sm text-muted-foreground">
          No deployment candidates were found.
        </p>
      )}
      <div
        role="radiogroup"
        aria-label="Repository detection"
        className="grid gap-2"
      >
        {result.detections.map((candidate) => {
          const selected =
            state.selected &&
            detectionKey(candidate) === detectionKey(state.selected);
          const name =
            candidate.type === "node"
              ? "Node.js"
              : candidate.type === "golang"
                ? "Go"
                : candidate.type === "staticfile"
                  ? "Static files"
                  : candidate.type === "dockerfile"
                    ? "Dockerfile"
                    : candidate.type === "compose"
                      ? "Docker Compose"
                      : candidate.type;
          return (
            <Button
              key={detectionKey(candidate)}
              type="button"
              variant="outline"
              role="radio"
              aria-checked={Boolean(selected)}
              onClick={() => state.select(detectionKey(candidate))}
              className={`h-auto justify-start p-3 text-left ${selected ? "border-primary" : ""}`}
            >
              <Package className="size-5 shrink-0" />
              <span>
                <span className="block font-medium">{name}</span>
                {(candidate.path ||
                  candidate.rootDir ||
                  candidate.metadata?.nodeRuntime) && (
                  <span className="block text-xs text-muted-foreground">
                    {candidate.path ||
                      candidate.rootDir ||
                      candidate.metadata?.nodeRuntime}
                  </span>
                )}
              </span>
            </Button>
          );
        })}
      </div>
      {result.logs
        ?.filter((log) => log.Level === "error")
        .map((log, index) => (
          <p key={index} className="text-sm text-destructive">
            {log.Msg}
          </p>
        ))}
      {!result.success && (
        <Button type="button" variant="outline" onClick={state.refresh}>
          Analyze again
        </Button>
      )}
    </div>
  );
}

export function DeplopackFields({ state }: { state: RepoAnalysisState }) {
  return (
    <AdvancedGroup title="Build settings">
      <div className="space-y-4">
        {(state.selected?.inputs ?? []).map((field) => {
          const id = `deplopack-${field.env}`;
          const values =
            state.values[field.env] ??
            (Array.isArray(field.defaultValue)
              ? field.defaultValue
              : field.defaultValue !== undefined
                ? [field.defaultValue]
                : []);
          return (
            <div key={field.env} className="space-y-2">
              <FieldLabel htmlFor={id} info={field.description}>
                {field.label}
              </FieldLabel>
              {field.type === "select" ? (
                <Select
                  value={values[0] ?? ""}
                  onValueChange={(value) => state.change(field.env, [value])}
                >
                  <SelectTrigger id={id}>
                    <SelectValue placeholder={field.placeholder} />
                  </SelectTrigger>
                  <SelectContent>
                    {field.options?.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : field.type === "text" ? (
                <Input
                  id={id}
                  value={values[0] ?? ""}
                  placeholder={field.placeholder}
                  onChange={(event) =>
                    state.change(field.env, [event.target.value])
                  }
                />
              ) : (
                <div className="space-y-2">
                  {values.map((value, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <Input
                        id={index === 0 ? id : undefined}
                        aria-label={`${field.label} ${index + 1}`}
                        className="font-mono"
                        value={value}
                        placeholder={field.placeholder}
                        onChange={(event) =>
                          state.change(
                            field.env,
                            values.map((entry, position) =>
                              position === index ? event.target.value : entry,
                            ),
                          )
                        }
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${field.label} ${index + 1}`}
                        onClick={() =>
                          state.change(
                            field.env,
                            values.filter((_, position) => position !== index),
                          )
                        }
                      >
                        <X className="size-4" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => state.change(field.env, [...values, ""])}
                  >
                    <Plus className="size-4" />
                    Add command
                  </Button>
                </div>
              )}
              {Object.hasOwn(state.values, field.env) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => state.reset(field.env)}
                >
                  Use detected value
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </AdvancedGroup>
  );
}
