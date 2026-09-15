"use client";

import { ExternalLink, Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CodeBlock, CommandLine } from "@/components/shared/code-block";
import { TOKEN_PLACEHOLDER, type AgentDef } from "../agents";
import { AgentMark } from "./agent-picker";
import { StepShell } from "./step-shell";

export function ConnectStep({
  agent,
  web,
  https,
  url,
  secret,
  gaveUp,
  onCheckAgain,
  onDone,
}: {
  agent: AgentDef;
  web: boolean;
  https: boolean;
  url: string;
  secret: string | null;
  gaveUp: boolean;
  onCheckAgain: () => void;
  onDone: () => void;
}) {
  return (
    <StepShell
      mark={<AgentMark agent={agent} size="lg" />}
      title={
        web
          ? `Add Deplo as a connector in ${agent.label}`
          : "Add this to your agent"
      }
      lead={
        web
          ? agent.hint
          : "The token is already in it. This is the only time Deplo can show that secret."
      }
      action={
        <>
          {gaveUp ? (
            <Button
              variant="outline"
              className="mr-auto"
              onClick={onCheckAgain}
            >
              Check again
            </Button>
          ) : (
            <span className="mr-auto flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Waiting for {agent.label} to call Deplo
            </span>
          )}
          <Button onClick={onDone}>Done</Button>
        </>
      }
    >
      <div className="w-full space-y-3 text-left">
        {agent.form === "command" ? (
          <CommandLine
            command={agent.snippet({
              url,
              token: secret ?? TOKEN_PLACEHOLDER,
            })}
          />
        ) : (
          <CodeBlock
            code={agent.snippet({
              url,
              token: secret ?? TOKEN_PLACEHOLDER,
            })}
            filename={agent.file}
            language={agent.language}
          />
        )}
        <p className="text-xs text-muted-foreground">
          {web
            ? "Deplo then asks you to sign in and choose what it may do. Nothing is shared until you approve it."
            : agent.hint}
        </p>

        {web && !https && (
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-[var(--warning)]" />
            <span>
              {agent.label} can only reach an address served over https. Set one
              under Settings → General.
            </span>
          </p>
        )}
        {!web && agent.form === "file" && (
          <p className="text-xs text-muted-foreground">
            Committing this file? Put the token in an environment variable and
            reference it instead.
          </p>
        )}

        <a
          href={agent.docsUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          {agent.label} documentation
          <ExternalLink className="size-3" />
        </a>

        {gaveUp && (
          <p className="text-sm text-muted-foreground">
            Deplo has not heard from {agent.label} yet. Start it, or ask it to
            list its tools.
          </p>
        )}
      </div>
    </StepShell>
  );
}
