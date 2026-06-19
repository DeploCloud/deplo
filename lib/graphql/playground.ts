import "server-only";

import {
  parse,
  validate,
  execute,
  GraphQLError,
  Kind,
  type DocumentNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type FragmentDefinitionNode,
} from "graphql";
import { schema } from "./schema";
import type { GraphQLContext } from "./context";
import type { FieldScope } from "./introspect";
import { runWithIdentity } from "@/lib/auth/request-context";
import { CAPABILITY_META } from "@/lib/membership-shared";
import type { Capability } from "@/lib/types";

/**
 * Bound on selection-set nesting for a playground query — the same intent as
 * the real endpoint's `maxDepthPlugin({ n: 12 })` (lib/graphql/yoga.ts), which
 * the graphql-js `execute()` path below does NOT otherwise enforce. Keeps a
 * deeply-nested read-only query from amplifying load past what the hardened
 * endpoint allows.
 */
const MAX_QUERY_DEPTH = 12;

/** Deepest selection-set nesting in an operation (fragments expanded). */
function operationDepth(
  op: OperationDefinitionNode,
  doc: DocumentNode,
): number {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const def of doc.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
  }
  const seen = new Set<string>();
  const depthOf = (selectionSet: SelectionSetNode | undefined): number => {
    if (!selectionSet) return 0;
    let max = 0;
    for (const sel of selectionSet.selections) {
      if (sel.kind === Kind.FIELD) {
        max = Math.max(max, 1 + depthOf(sel.selectionSet));
      } else if (sel.kind === Kind.INLINE_FRAGMENT) {
        max = Math.max(max, depthOf(sel.selectionSet));
      } else if (sel.kind === Kind.FRAGMENT_SPREAD && !seen.has(sel.name.value)) {
        seen.add(sel.name.value);
        max = Math.max(max, depthOf(fragments.get(sel.name.value)?.selectionSet));
      }
    }
    return max;
  };
  return depthOf(op.selectionSet);
}

/**
 * The in-dashboard GraphQL playground executor.
 *
 * SECURITY MODEL — the playground is a *safe sandbox*, deliberately weaker than
 * the real `/api/graphql` endpoint:
 *
 *  1. Only `query` operations ever touch a resolver. They run read-only against
 *     the caller's live session data, exactly as the real API would.
 *  2. `mutation` operations are NEVER executed. We parse the document, look at
 *     each top-level mutation field, and synthesise the response:
 *       - if the caller lacks the field's required capability → "permission
 *         denied" (the same boundary the real API enforces), OR
 *       - if they hold it → a dry-run notice ("… would have run").
 *     Nothing is deployed, restarted, deleted or created.
 *  3. `subscription` operations are rejected outright.
 *
 * This means a viewer can freely explore the API — including destructive
 * mutations — and see *exactly* what would happen and whether they're allowed,
 * without any side effect. The real API (cookie or bearer token) is unchanged;
 * this gate lives only in front of the playground route.
 */

/** A single field's simulated outcome inside a dry-run mutation. */
export interface DryRunField {
  field: string;
  allowed: boolean;
  /** Human message: the dry-run notice or the permission-denied reason. */
  message: string;
  /** The capability the field requires, when it gates on one. */
  requires: Capability | null;
}

export type PlaygroundResult =
  | {
      /** A real, executed read-only query. */
      kind: "query";
      data: unknown;
      errors: { message: string }[] | null;
    }
  | {
      /** A simulated mutation — nothing ran. */
      kind: "dry-run";
      fields: DryRunField[];
    }
  | {
      /** The request could not be processed (parse/validate/shape error). */
      kind: "error";
      errors: { message: string }[];
    };

/** Does the caller satisfy this field's scope, given their context? */
function isAllowed(scope: FieldScope, ctx: GraphQLContext): boolean {
  switch (scope.kind) {
    case "public":
      return true;
    case "loggedIn":
      return !!ctx.viewer;
    case "instanceAdmin":
      return !!ctx.viewer?.isInstanceAdmin;
    case "capability":
      return ctx.capabilities.includes(scope.capability);
  }
}

/** Lift a mutation field's `authScopes` to a {@link FieldScope}. */
function scopeOfMutationField(name: string): FieldScope {
  const mutationType = schema.getMutationType();
  const field = mutationType?.getFields()[name];
  const raw = (
    field?.extensions as { pothosOptions?: { authScopes?: unknown } } | undefined
  )?.pothosOptions?.authScopes as
    | { loggedIn?: boolean; capability?: Capability; instanceAdmin?: boolean }
    | undefined;
  if (!raw || typeof raw !== "object") return { kind: "public" };
  if (raw.instanceAdmin) return { kind: "instanceAdmin" };
  if (raw.capability) return { kind: "capability", capability: raw.capability };
  if (raw.loggedIn) return { kind: "loggedIn" };
  return { kind: "public" };
}

/** Render why a scope was denied, in human terms. */
function deniedReason(scope: FieldScope): string {
  switch (scope.kind) {
    case "instanceAdmin":
      return "Permission denied — requires instance-admin access.";
    case "capability": {
      const label = CAPABILITY_META[scope.capability]?.label ?? scope.capability;
      return `Permission denied — requires the “${label}” capability (${scope.capability}).`;
    }
    case "loggedIn":
      return "Permission denied — you must be signed in.";
    case "public":
      return "Permission denied.";
  }
}

/** The single operation a request runs: the named one, or the only one. */
function pickOperation(
  doc: DocumentNode,
  operationName: string | null,
): OperationDefinitionNode | null {
  const ops = doc.definitions.filter(
    (d): d is OperationDefinitionNode =>
      d.kind === Kind.OPERATION_DEFINITION,
  );
  if (ops.length === 0) return null;
  if (operationName) {
    return ops.find((o) => o.name?.value === operationName) ?? null;
  }
  // No name given: only valid if there is exactly one operation.
  return ops.length === 1 ? ops[0] : null;
}

/**
 * Top-level mutation field names — resolving fragment spreads and inline
 * fragments so a mutation written as `mutation { ...F }` is still fully gated
 * (otherwise it would show an empty dry run). De-duplicated and meta-fields
 * (`__typename`) skipped. Fragment cycles are impossible in a validated doc, but
 * a `seen` set guards anyway.
 */
function topLevelMutationFields(
  op: OperationDefinitionNode,
  doc: DocumentNode,
): string[] {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const def of doc.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
  }

  const names = new Set<string>();
  const seenFragments = new Set<string>();

  const walk = (selectionSet: SelectionSetNode) => {
    for (const sel of selectionSet.selections) {
      if (sel.kind === Kind.FIELD) {
        if (sel.name.value.startsWith("__")) continue;
        names.add(sel.name.value);
      } else if (sel.kind === Kind.INLINE_FRAGMENT) {
        walk(sel.selectionSet);
      } else if (sel.kind === Kind.FRAGMENT_SPREAD) {
        const frag = fragments.get(sel.name.value);
        if (frag && !seenFragments.has(sel.name.value)) {
          seenFragments.add(sel.name.value);
          walk(frag.selectionSet);
        }
      }
    }
  };

  walk(op.selectionSet);
  return [...names];
}

/**
 * Run an operation in the playground sandbox. `ctx` is the SAME context the
 * real endpoint builds (so query results match production exactly), but a
 * mutation never reaches `execute()` — it is simulated against `ctx`'s scopes.
 */
export async function runPlayground(
  source: string,
  variables: Record<string, unknown> | undefined,
  operationName: string | null,
  ctx: GraphQLContext,
): Promise<PlaygroundResult> {
  if (!ctx.viewer) {
    return {
      kind: "error",
      errors: [{ message: "You must be signed in to use the playground." }],
    };
  }

  // 1. Parse.
  let doc: DocumentNode;
  try {
    doc = parse(source);
  } catch (e) {
    return {
      kind: "error",
      errors: [
        { message: e instanceof GraphQLError ? e.message : "Invalid GraphQL." },
      ],
    };
  }

  // 2. Validate against the real schema — same rules the API enforces, so an
  // invalid field/arg fails here exactly as it would in production.
  const validationErrors = validate(schema, doc);
  if (validationErrors.length > 0) {
    return {
      kind: "error",
      errors: validationErrors.map((e) => ({ message: e.message })),
    };
  }

  // 3. Resolve which operation runs.
  const op = pickOperation(doc, operationName);
  if (!op) {
    return {
      kind: "error",
      errors: [
        {
          message:
            "Provide exactly one operation, or pass an operationName to choose one.",
        },
      ],
    };
  }

  // 4. Subscriptions are not supported in the playground.
  if (op.operation === "subscription") {
    return {
      kind: "error",
      errors: [
        { message: "Subscriptions are not supported in the playground." },
      ],
    };
  }

  // 5. Mutation → DRY RUN. Never execute; simulate each top-level field.
  if (op.operation === "mutation") {
    const fields = topLevelMutationFields(op, doc).map<DryRunField>((name) => {
      const scope = scopeOfMutationField(name);
      const allowed = isAllowed(scope, ctx);
      const requires =
        scope.kind === "capability" ? scope.capability : null;
      return {
        field: name,
        allowed,
        requires,
        message: allowed
          ? `Dry run: \`${name}\` would have executed with these arguments. ` +
            `Mutations are disabled in the playground, so nothing changed.`
          : deniedReason(scope),
      };
    });
    return { kind: "dry-run", fields };
  }

  // 6. Query → execute for real, READ-ONLY, against the caller's live data.
  // The context is the same one the real endpoint builds, so the viewer only
  // ever sees their own team's data and the scope-auth layer still applies to
  // every field. A query cannot mutate, so this is safe to run verbatim.

  // Match the real endpoint's depth bound (graphql-js execute() has none).
  if (operationDepth(op, doc) > MAX_QUERY_DEPTH) {
    return {
      kind: "error",
      errors: [
        {
          message: `Query is too deeply nested (max depth ${MAX_QUERY_DEPTH}).`,
        },
      ],
    };
  }

  // Re-establish the bearer-token identity around execution, exactly like the
  // real endpoint's `identityPlugin` (lib/graphql/yoga.ts): resolvers run in a
  // fresh async context, so without this a token request would resolve data
  // against cookies. Null identity (the in-app cookie path) needs no wrap.
  const runExecute = () =>
    execute({
      schema,
      document: doc,
      contextValue: ctx,
      variableValues: variables,
      operationName: operationName ?? undefined,
    });
  const result = ctx.identity
    ? await runWithIdentity(ctx.identity, runExecute)
    : await runExecute();

  return {
    kind: "query",
    data: result.data ?? null,
    errors: result.errors?.length
      ? result.errors.map((e) => ({ message: e.message }))
      : null,
  };
}
