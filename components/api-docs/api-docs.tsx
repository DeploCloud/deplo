"use client";

import * as React from "react";
import { BookOpen, FlaskConical, FileCode2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Tabs,
  TabsContent,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/ui/tabs";
import { CopyButton } from "@/components/shared/copy-button";
import { ApiReference } from "./api-reference";
import { Playground } from "./playground";
import { PermissionsSummary } from "./permissions-summary";
import { clientSchemaFrom } from "./graphql-language";
import type { Capability } from "@/lib/types";
import type { ApiCatalog } from "./types";

/**
 * The API reference + playground surface. Three tabs: the searchable reference,
 * the secure playground, and the raw SDL. The reference's "Try it" buttons hand
 * an operation to the playground and switch to its tab.
 */
export function ApiDocs({
  catalog,
  capabilities,
  isInstanceAdmin,
}: {
  catalog: ApiCatalog;
  capabilities: Capability[];
  isInstanceAdmin: boolean;
}) {
  const [tab, setTab] = React.useState("reference");
  const [tryOp, setTryOp] = React.useState<{ value: string; nonce: number }>({
    value: "",
    nonce: 0,
  });

  // Rebuild the schema once for both the reference (valid examples) and the
  // playground editor (validation + autocomplete).
  const schema = React.useMemo(
    () => clientSchemaFrom(catalog.introspection),
    [catalog.introspection],
  );

  const handleTry = React.useCallback((operation: string) => {
    setTryOp((prev) => ({ value: operation, nonce: prev.nonce + 1 }));
    setTab("playground");
  }, []);

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <UnderlineTabsList>
        <UnderlineTabsTrigger value="reference">
          <BookOpen className="size-4" />
          Reference
        </UnderlineTabsTrigger>
        <UnderlineTabsTrigger value="playground">
          <FlaskConical className="size-4" />
          Playground
        </UnderlineTabsTrigger>
        <UnderlineTabsTrigger value="schema">
          <FileCode2 className="size-4" />
          Schema (SDL)
        </UnderlineTabsTrigger>
      </UnderlineTabsList>

      <TabsContent value="reference" className="mt-4 space-y-4">
        <PermissionsSummary
          capabilities={capabilities}
          isInstanceAdmin={isInstanceAdmin}
        />
        <Card>
          <CardHeader>
            <CardTitle className="text-base">GraphQL reference</CardTitle>
            <CardDescription>
              Every operation the API exposes. Badges show the capability each
              one requires — green means you already hold it. Endpoint:{" "}
              <code className="font-mono text-xs">POST /api/graphql</code>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ApiReference
              catalog={catalog}
              capabilities={capabilities}
              isInstanceAdmin={isInstanceAdmin}
              schema={schema}
              onTry={handleTry}
            />
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="playground" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FlaskConical className="size-4" />
              Playground
            </CardTitle>
            <CardDescription>
              Read-only queries run for real against your team’s data. Mutations
              are <span className="font-medium">never executed</span> — they’re
              simulated as a capability-aware dry run, so you can explore the
              whole API safely.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Playground
              initialOperation={tryOp}
              introspection={catalog.introspection}
            />
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="schema" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-base">
              Schema (SDL)
              <CopyButton value={catalog.sdl} label="Copy SDL" />
            </CardTitle>
            <CardDescription>
              The full GraphQL schema in SDL — paste into your codegen or client
              tooling.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="max-h-[600px] overflow-auto rounded-lg border border-border bg-background p-3 font-mono text-xs">
              {catalog.sdl}
            </pre>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}
