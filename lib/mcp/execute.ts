import "server-only";

import {
  execute,
  Kind,
  parse,
  specifiedRules,
  TypeInfo,
  validate,
  visit,
  visitWithTypeInfo,
  type DocumentNode,
} from "graphql";
import { maxDepthRule } from "@escape.tech/graphql-armor-max-depth";
import { maxAliasesRule } from "@escape.tech/graphql-armor-max-aliases";
import { costLimitRule } from "@escape.tech/graphql-armor-cost-limit";
import { schema } from "../graphql/schema";
import { safeMessage } from "../graphql/mask-error";
import { runWithIdentity } from "../auth/request-context";
import type { GraphQLContext } from "../graphql/context";

const parsed = new Map<string, DocumentNode>();

function documentFor(query: string): DocumentNode {
  let doc = parsed.get(query);
  if (!doc) {
    doc = parse(query);
    parsed.set(query, doc);
  }
  return doc;
}

export interface ToolExecution {
  data: unknown;
  error?: string;
}

// Runs in-process against the schema /api/graphql serves - no second authorization path (ADR-0021).
export async function runGraphql(
  query: string | DocumentNode,
  variables: Record<string, unknown>,
  ctx: GraphQLContext,
): Promise<ToolExecution> {
  const document = typeof query === "string" ? documentFor(query) : query;
  const run = () =>
    execute({
      schema,
      document,
      variableValues: variables,
      contextValue: ctx,
    });
  // No identity must resolve NOTHING rather than run unattributed; runWithIdentity has no null form.
  const value = await (ctx.identity
    ? runWithIdentity(ctx.identity, run)
    : run());
  const first = value.errors?.[0];
  const error = first ? safeMessage(first) : undefined;
  return { data: value.data ?? null, error };
}

// Hand-listed because they hand back a credential or run code without a reveal* name (ADR-0021 rule 4).
const IRREGULAR = [
  "execConsole",
  "execDatabaseConsole",
  "rotateDatabasePassword",
  "rotateAppDeployHook",
  "destinationRecoveryKey",
  "createToken",
  "updateToken",
  "mintRegistrationLink",
  "reissueServerBootstrap",
  "regenerateRecoveryCodes",
  "startTwoFactorEnrolment",
  "startPasskeyRegistration",
  "passkeyChallenge",
  "login",
  "verifyPasskeyLogin",
  "verifyTwoFactorLogin",
];

let denied: Set<string> | undefined;

export function deniedRootFields(): Set<string> {
  denied ??= new Set(
    [
      ...Object.keys(schema.getQueryType()!.getFields()),
      ...Object.keys(schema.getMutationType()!.getFields()),
    ]
      .filter((name) => /^reveal[A-Z]/.test(name))
      .concat(IRREGULAR),
  );
  return denied;
}

const PASSTHROUGH_RULES = [
  ...specifiedRules,
  maxDepthRule({ n: 12 }),
  maxAliasesRule({ n: 30 }),
  costLimitRule({ maxCost: 5000 }),
];

export function admitPassthrough(
  query: string,
  kind: "query" | "mutation",
): DocumentNode {
  const doc = parse(query);

  const ops = doc.definitions.filter(
    (d) => d.kind === Kind.OPERATION_DEFINITION,
  );
  if (ops.length === 0)
    throw new Error("That document has no query or mutation in it.");
  for (const op of ops)
    if (op.operation !== kind)
      throw new Error(
        op.operation === "subscription"
          ? "Subscriptions cannot be run over MCP. Poll the matching read instead."
          : `graphql_${kind === "query" ? "query" : "mutate"} runs ${kind} operations only, and this document is a ${op.operation}. Use graphql_${op.operation === "mutation" ? "mutate" : "query"}.`,
      );

  // Before validate(), so a denied field hears why; parent-typed, so a login FIELD stays readable.
  const blocked = deniedRootFields();
  const typeInfo = new TypeInfo(schema);
  visit(
    doc,
    visitWithTypeInfo(typeInfo, {
      Field(node) {
        const parent = typeInfo.getParentType();
        if (
          (parent === schema.getQueryType() ||
            parent === schema.getMutationType()) &&
          blocked.has(node.name.value)
        )
          throw new Error(
            `"${node.name.value}" cannot be run over MCP. It returns a credential or runs a command, and a secret that reaches a model's context has left Deplo for good. Use the Deplo dashboard for this one.`,
          );
      },
    }),
  );

  const errors = validate(schema, doc, PASSTHROUGH_RULES);
  if (errors.length) throw new Error(errors[0].message);

  return doc;
}
