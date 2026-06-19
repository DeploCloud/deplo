"use client";

import * as React from "react";
import {
  Play,
  Loader2,
  ShieldCheck,
  ShieldX,
  TriangleAlert,
  Database,
  FlaskConical,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/shared/copy-button";
import { GraphqlEditor } from "./graphql-editor";
import { CURATED_EXAMPLES } from "./examples";
import { cn } from "@/lib/utils";
import type { PlaygroundResult } from "./types";

/**
 * The secure GraphQL playground. Sends the operation to
 * `/api/graphql/playground` (NOT the real endpoint): read-only queries execute
 * for real against the viewer's data, mutations come back as a capability-aware
 * dry run. The component is purely a presenter of whichever `PlaygroundResult`
 * the server returns — all the safety lives server-side.
 */

/**
 * The name of the first named operation, or null. Lightweight regex so we don't
 * pull the parser into render; the server still validates precisely. Lets a
 * multi-operation document run (targeting the first) instead of erroring.
 */
function firstOperationName(source: string): string | null {
  const m = /\b(?:query|mutation|subscription)\s+([_A-Za-z][_A-Za-z0-9]*)/.exec(
    source,
  );
  return m ? m[1] : null;
}

const STARTER = `# Read-only queries run for real. Mutations are simulated (dry run).
# Press ⌘/Ctrl + Enter to run.
query WhoAmI {
  me {
    id
    username
    role
    isInstanceAdmin
  }
  apiContext
}`;

export function Playground({
  initialOperation,
  introspection,
}: {
  /** Imperatively set from "Try it" in the reference — bumps on each click. */
  initialOperation?: { value: string; nonce: number };
  /** Schema introspection JSON — drives editor validation + autocomplete. */
  introspection?: unknown;
}) {
  const [source, setSource] = React.useState(STARTER);
  const [variables, setVariables] = React.useState("{}");
  const [result, setResult] = React.useState<PlaygroundResult | null>(null);
  const [running, setRunning] = React.useState(false);
  const [showVars, setShowVars] = React.useState(false);

  // When the reference fires "Try it", load that operation in.
  const lastNonce = React.useRef<number>(-1);
  React.useEffect(() => {
    if (
      initialOperation &&
      initialOperation.nonce !== lastNonce.current &&
      initialOperation.value
    ) {
      lastNonce.current = initialOperation.nonce;
      setSource(initialOperation.value);
      setResult(null);
    }
  }, [initialOperation]);

  const run = React.useCallback(async () => {
    setRunning(true);
    try {
      let parsedVars: unknown = undefined;
      const trimmed = variables.trim();
      if (trimmed && trimmed !== "{}") {
        try {
          parsedVars = JSON.parse(trimmed);
        } catch {
          setResult({
            kind: "error",
            errors: [{ message: "Variables must be valid JSON." }],
          });
          setRunning(false);
          return;
        }
      }
      const res = await fetch("/api/graphql/playground", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          query: source,
          variables: parsedVars,
          // When the document has several named operations, target the first so
          // a multi-operation document runs instead of erroring.
          operationName: firstOperationName(source),
        }),
      });
      const json = (await res.json()) as PlaygroundResult;
      setResult(json);
    } catch {
      setResult({
        kind: "error",
        errors: [{ message: "Network error — could not reach the playground." }],
      });
    } finally {
      setRunning(false);
    }
  }, [source, variables]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          Examples:
        </span>
        {CURATED_EXAMPLES.map((ex) => (
          <button
            key={ex.label}
            type="button"
            onClick={() => {
              setSource(ex.operation);
              setResult(null);
            }}
            title={ex.description}
            aria-label={`Load example: ${ex.label}. ${ex.description}`}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs transition-colors hover:bg-secondary",
              ex.kind === "mutation"
                ? "text-[var(--warning)]"
                : "text-foreground",
            )}
          >
            {ex.kind === "mutation" ? (
              <FlaskConical className="size-3" />
            ) : (
              <Database className="size-3" />
            )}
            {ex.label}
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Editor column */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              Operation
            </span>
            <button
              type="button"
              onClick={() => setShowVars((v) => !v)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              {showVars ? "Hide variables" : "Variables"}
            </button>
          </div>
          <GraphqlEditor
            value={source}
            onChange={setSource}
            onRun={run}
            introspection={introspection}
          />
          {showVars && (
            <textarea
              value={variables}
              onChange={(e) => setVariables(e.target.value)}
              spellCheck={false}
              aria-label="GraphQL variables (JSON)"
              className="h-24 w-full rounded-lg border border-input bg-background p-2 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder='{ "id": "prj_123" }'
            />
          )}
          <div className="flex items-center gap-2">
            <Button onClick={run} disabled={running} size="sm">
              {running ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
              {running ? "Running…" : "Run"}
            </Button>
            <span className="text-xs text-muted-foreground">⌘/Ctrl + Enter</span>
          </div>
        </div>

        {/* Result column */}
        <div className="space-y-2">
          <span className="text-xs font-medium text-muted-foreground">
            Result
          </span>
          <ResultPanel result={result} />
        </div>
      </div>
    </div>
  );
}

function ResultPanel({ result }: { result: PlaygroundResult | null }) {
  if (!result) {
    return (
      <div className="flex h-[320px] items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
        Run an operation to see the result here.
      </div>
    );
  }

  if (result.kind === "dry-run") {
    return (
      <div className="space-y-2 rounded-lg border border-border bg-card p-3">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <FlaskConical className="size-3.5" />
          Dry run — nothing was executed
        </div>
        {result.fields.map((f) => (
          <div
            key={f.field}
            className={cn(
              "flex items-start gap-2 rounded-md border p-2.5 text-sm",
              f.allowed
                ? "border-[var(--success)]/30 bg-[var(--success)]/5"
                : "border-[var(--destructive)]/30 bg-[var(--destructive)]/5",
            )}
          >
            {f.allowed ? (
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-[var(--success)]" />
            ) : (
              <ShieldX className="mt-0.5 size-4 shrink-0 text-[var(--destructive)]" />
            )}
            <div>
              <code className="font-mono text-xs font-medium">{f.field}</code>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {f.message}
              </p>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (result.kind === "error") {
    return (
      <div className="space-y-1.5 rounded-lg border border-[var(--destructive)]/30 bg-[var(--destructive)]/5 p-3">
        <div className="flex items-center gap-2 text-xs font-medium text-[var(--destructive)]">
          <TriangleAlert className="size-3.5" />
          Error
        </div>
        {result.errors.map((e, i) => (
          <p key={i} className="font-mono text-xs text-muted-foreground">
            {e.message}
          </p>
        ))}
      </div>
    );
  }

  // kind === "query"
  const json = JSON.stringify(
    result.errors ? { data: result.data, errors: result.errors } : result.data,
    null,
    2,
  );
  return (
    <div className="relative">
      {result.errors && (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-[var(--warning)]/30 bg-[var(--warning)]/5 px-2.5 py-1.5 text-xs text-muted-foreground">
          <TriangleAlert className="size-3.5 text-[var(--warning)]" />
          Returned with field errors.
        </div>
      )}
      <div className="absolute right-2 top-2 z-10">
        <CopyButton value={json} />
      </div>
      <pre className="h-[320px] overflow-auto rounded-lg border border-border bg-background p-3 font-mono text-xs">
        {json}
      </pre>
    </div>
  );
}
