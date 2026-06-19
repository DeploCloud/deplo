"use client";

import {
  buildClientSchema,
  parse,
  validate,
  GraphQLError,
  type GraphQLSchema,
  type GraphQLNamedType,
  GraphQLObjectType,
  GraphQLInterfaceType,
  GraphQLInputObjectType,
  GraphQLEnumType,
  type GraphQLField,
  type GraphQLArgument,
  type GraphQLInputField,
  isObjectType,
  isInterfaceType,
  isInputObjectType,
  isEnumType,
  isLeafType,
  getNamedType,
  type IntrospectionQuery,
} from "graphql";
import type { Diagnostic } from "@codemirror/lint";
import type { CompletionSource, Completion } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";

/**
 * Schema-aware GraphQL language support for the playground editor, built from
 * the introspection JSON the server ships in the catalog. No extra dependency:
 * `graphql` is already bundled, and `buildClientSchema` reconstructs a real
 * `GraphQLSchema` the validator and completion engine read directly.
 *
 * Two capabilities:
 *  - `makeGraphqlLinter(schema)` → a CodeMirror linter that parses + validates
 *    against the real schema, surfacing precise errors (unknown field, wrong
 *    arg type, …) as squiggles at the right span.
 *  - `makeGraphqlCompletion(schema)` → a `CompletionSource` that suggests
 *    operation keywords, the fields valid at the cursor's type, argument names,
 *    and enum / boolean / null values — i.e. hinting for every value you can
 *    put at that position.
 */

/** Rebuild a usable schema from the introspection JSON, or null if malformed. */
export function clientSchemaFrom(introspection: unknown): GraphQLSchema | null {
  try {
    return buildClientSchema(
      (introspection as { __schema: IntrospectionQuery["__schema"] }) ??
        ({} as never),
    );
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Example generation (schema-aware, always valid)                     */
/* ------------------------------------------------------------------ */

/** A literal placeholder for an input value of `type`, valid GraphQL. */
function exampleValueForInput(
  type: GraphQLNamedType,
  depth = 0,
): string {
  if (isEnumType(type)) {
    // First enum member — always a valid literal.
    return type.getValues()[0]?.name ?? "null";
  }
  if (isInputObjectType(type)) {
    if (depth > 3) return "{}"; // guard against deep/recursive inputs
    const fields = Object.values(type.getFields()).filter((f) =>
      f.type.toString().endsWith("!"),
    );
    if (fields.length === 0) return "{}";
    const inner = fields
      .map(
        (f) =>
          `${f.name}: ${exampleValueForInput(getNamedType(f.type), depth + 1)}`,
      )
      .join(", ");
    return `{ ${inner} }`;
  }
  // Scalars.
  switch (type.name) {
    case "Int":
    case "Float":
      return "0";
    case "Boolean":
      return "false";
    case "JSON":
      return "{}";
    default:
      return '""'; // String / ID / DateTime / custom scalars
  }
}

/** A small, valid sub-selection for an object return type (a few scalar fields). */
function exampleSelection(type: GraphQLNamedType, depth = 0): string {
  const fields = fieldsOf(type);
  if (!fields) return ""; // leaf (scalar/enum) — no selection set
  const pad = "  ".repeat(depth + 2);
  const closePad = "  ".repeat(depth + 1);
  // Prefer a handful of scalar fields so the example is runnable as-is.
  const picked: string[] = [];
  for (const f of Object.values(fields)) {
    const named = getNamedType((f as GraphQLField<unknown, unknown>).type);
    const hasRequiredArgs = (
      "args" in f ? (f as GraphQLField<unknown, unknown>).args : []
    ).some((a) => a.type.toString().endsWith("!"));
    if (hasRequiredArgs) continue; // skip fields that would need args
    if (isLeafType(named)) {
      picked.push(`${pad}${f.name}`);
      if (picked.length >= 5) break;
    }
  }
  if (picked.length === 0) {
    // Object with no plain scalar fields — fall back to __typename.
    picked.push(`${pad}__typename`);
  }
  return ` {\n${picked.join("\n")}\n${closePad}}`;
}

/**
 * Build a valid example operation for a root field directly from the schema, so
 * required enum / input-object arguments and object sub-selections are correct
 * (the string-heuristic fallback in `examples.ts` cannot see types and may emit
 * invalid GraphQL). Returns null when the field isn't found.
 */
export function schemaExampleFor(
  schema: GraphQLSchema,
  fieldName: string,
  operation: "query" | "mutation",
): string | null {
  const root =
    operation === "query" ? schema.getQueryType() : schema.getMutationType();
  const field = root?.getFields()[fieldName];
  if (!field) return null;

  const requiredArgs = field.args.filter((a) =>
    a.type.toString().endsWith("!"),
  );
  const argStr =
    requiredArgs.length > 0
      ? `(${requiredArgs
          .map(
            (a) => `${a.name}: ${exampleValueForInput(getNamedType(a.type))}`,
          )
          .join(", ")})`
      : "";

  const selection = exampleSelection(getNamedType(field.type));
  return `${operation} {\n  ${fieldName}${argStr}${selection}\n}`;
}

/* ------------------------------------------------------------------ */
/* Linting                                                             */
/* ------------------------------------------------------------------ */

/** Map a GraphQL error (1-based line/col locations) to a CM document offset. */
function locToOffset(
  view: EditorView,
  line: number,
  column: number,
): number {
  const doc = view.state.doc;
  const lineNo = Math.min(Math.max(line, 1), doc.lines);
  const lineObj = doc.line(lineNo);
  return Math.min(lineObj.from + Math.max(column - 1, 0), lineObj.to);
}

/** A CodeMirror linter that validates the document against `schema`. */
export function makeGraphqlLinter(schema: GraphQLSchema) {
  return (view: EditorView): Diagnostic[] => {
    const text = view.state.doc.toString();
    if (!text.trim()) return [];

    const diagnostics: Diagnostic[] = [];
    let document;
    try {
      document = parse(text);
    } catch (e) {
      // A syntax error carries a single location.
      const err = e as GraphQLError;
      const loc = err.locations?.[0];
      const from = loc ? locToOffset(view, loc.line, loc.column) : 0;
      diagnostics.push({
        from,
        to: Math.min(from + 1, view.state.doc.length),
        severity: "error",
        message: err.message,
        source: "graphql",
      });
      return diagnostics;
    }

    for (const err of validate(schema, document)) {
      const loc = err.locations?.[0];
      const from = loc ? locToOffset(view, loc.line, loc.column) : 0;
      // Highlight to the end of the offending word so the squiggle is findable.
      const lineEnd = view.state.doc.lineAt(from).to;
      const wordEnd = (() => {
        const slice = view.state.doc.sliceString(from, lineEnd);
        const m = /^[_A-Za-z0-9]+/.exec(slice);
        return m ? from + m[0].length : Math.min(from + 1, lineEnd);
      })();
      diagnostics.push({
        from,
        to: wordEnd,
        severity: "error",
        message: err.message,
        source: "graphql",
      });
    }
    return diagnostics;
  };
}

/* ------------------------------------------------------------------ */
/* Autocomplete                                                        */
/* ------------------------------------------------------------------ */

const OPERATION_KEYWORDS = ["query", "mutation", "subscription", "fragment"];
const VALUE_KEYWORDS = ["true", "false", "null"];

type FieldHolder =
  | GraphQLObjectType
  | GraphQLInterfaceType
  | GraphQLInputObjectType;

function fieldsOf(
  type: GraphQLNamedType | null | undefined,
): Record<string, GraphQLField<unknown, unknown> | GraphQLInputField> | null {
  if (!type) return null;
  if (isObjectType(type) || isInterfaceType(type) || isInputObjectType(type)) {
    return (type as FieldHolder).getFields();
  }
  return null;
}

/**
 * Resolve which type the cursor is "inside" by scanning the text before it.
 * We walk token-by-token, maintaining a stack of types: each `{` after a field
 * descends into that field's (named) type; each `}` pops. The operation keyword
 * (or its absence → query) seeds the stack with the root type. This is a
 * pragmatic, position-aware resolver — robust for the common editing cases the
 * playground sees, without a full incremental parser.
 */
interface CursorContext {
  /** The type whose fields are valid at the cursor (selection set), if any. */
  selectionType: GraphQLNamedType | null;
  /** True when the cursor sits inside a field's `( … )` argument list. */
  inArgs: boolean;
  /** The field that owns the current argument list (for arg-name hints). */
  argField: GraphQLField<unknown, unknown> | GraphQLInputField | null;
  /** When right after `argName:`, the expected input type (for value hints). */
  expectedValueType: GraphQLNamedType | null;
  /** True at the very top level, before/around the operation keyword. */
  atTopLevel: boolean;
  /** Field names already written in the current selection set (skip in hints). */
  usedFields: Set<string>;
  /** Argument names already written in the current arg list (skip in hints). */
  usedArgs: Set<string>;
}

function resolveContext(
  schema: GraphQLSchema,
  textBefore: string,
): CursorContext {
  // Tokenize into words, punctuation and strings (good enough; we only need the
  // structure, not exact GraphQL lexing).
  const tokens = textBefore.match(/"[^"]*"|[_A-Za-z][_A-Za-z0-9]*|[{}():,]|\S/g) ?? [];

  // The token at the cursor is the identifier being typed — it is NOT yet
  // "already inserted", so exclude it from the used-name sets below.
  // Only the LAST token is "partial" — and only when the cursor sits directly
  // on it (the text ends with an identifier char, no whitespace/punctuation
  // after). `foo ` ends with a space → `foo` is committed, not partial.
  const endsWithPartial =
    /[_A-Za-z0-9]$/.test(textBefore) &&
    tokens.length > 0 &&
    /^[_A-Za-z]/.test(tokens[tokens.length - 1]);
  const lastIndex = tokens.length - 1;

  const queryRoot = schema.getQueryType() ?? null;
  const mutationRoot = schema.getMutationType() ?? null;
  const subRoot = schema.getSubscriptionType() ?? null;

  // Decide the root type from the first operation keyword (default: query).
  let rootType: GraphQLNamedType | null = queryRoot;
  const firstKw = tokens.find((t) => OPERATION_KEYWORDS.includes(t));
  if (firstKw === "mutation") rootType = mutationRoot;
  else if (firstKw === "subscription") rootType = subRoot;

  // Stack of selection types; index 0 is the root, pushed on the first `{`.
  const typeStack: (GraphQLNamedType | null)[] = [];
  // Parallel stack of field names already present at each selection-set level,
  // so we never re-suggest a field the user already wrote at this level.
  const usedFieldsStack: Set<string>[] = [];
  // The most recent field name seen at the current level (what a `{` descends).
  let pendingField: GraphQLField<unknown, unknown> | GraphQLInputField | null =
    null;
  let lastFieldName: string | null = null;
  let sawAnyBrace = false;

  let inArgs = false;
  let argField: GraphQLField<unknown, unknown> | GraphQLInputField | null = null;
  let expectedValueType: GraphQLNamedType | null = null;
  let lastArgName: string | null = null;
  let afterColonInArgs = false;
  // Argument names already present in the current `( … )` list.
  let usedArgs = new Set<string>();

  const currentType = (): GraphQLNamedType | null =>
    typeStack.length ? typeStack[typeStack.length - 1] : null;
  const currentUsedFields = (): Set<string> =>
    usedFieldsStack.length
      ? usedFieldsStack[usedFieldsStack.length - 1]
      : new Set();

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    // Skip the in-progress identifier at the very end — it isn't committed yet.
    const isPartialAtCursor = endsWithPartial && i === lastIndex;

    if (tok === "{") {
      sawAnyBrace = true;
      if (typeStack.length === 0) {
        typeStack.push(rootType);
      } else {
        // Descend into the pending field's named type.
        const named = pendingField
          ? getNamedType(pendingField.type)
          : null;
        typeStack.push(named ?? null);
      }
      usedFieldsStack.push(new Set());
      pendingField = null;
      continue;
    }
    if (tok === "}") {
      typeStack.pop();
      usedFieldsStack.pop();
      pendingField = null;
      continue;
    }
    if (tok === "(") {
      inArgs = true;
      argField = pendingField ?? lastFieldByName(currentType(), lastFieldName);
      afterColonInArgs = false;
      usedArgs = new Set();
      continue;
    }
    if (tok === ")") {
      inArgs = false;
      argField = null;
      expectedValueType = null;
      afterColonInArgs = false;
      usedArgs = new Set();
      continue;
    }
    if (tok === ":") {
      if (inArgs && lastArgName && argField) {
        afterColonInArgs = true;
        const arg = argsOf(argField).find((a) => a.name === lastArgName);
        expectedValueType = arg ? getNamedType(arg.type) : null;
      }
      continue;
    }
    if (tok === "," ) {
      afterColonInArgs = false;
      expectedValueType = null;
      continue;
    }

    // A bare name token.
    if (/^[_A-Za-z]/.test(tok)) {
      if (inArgs) {
        if (!afterColonInArgs) {
          lastArgName = tok;
          // An arg name is "used" once followed by a `:`; record it unless it
          // is the partial token at the cursor.
          if (!isPartialAtCursor) usedArgs.add(tok);
        }
      } else {
        // A field name in the current selection set.
        lastFieldName = tok;
        const fields = fieldsOf(currentType());
        pendingField = fields?.[tok] ?? null;
        if (!isPartialAtCursor && !OPERATION_KEYWORDS.includes(tok)) {
          currentUsedFields().add(tok);
        }
      }
    }
  }

  return {
    selectionType: inArgs ? null : currentType(),
    inArgs,
    argField,
    expectedValueType: afterColonInArgs ? expectedValueType : null,
    atTopLevel: !sawAnyBrace,
    usedFields: currentUsedFields(),
    usedArgs,
  };
}

function argsOf(
  field: GraphQLField<unknown, unknown> | GraphQLInputField,
): readonly GraphQLArgument[] {
  return "args" in field && Array.isArray(field.args) ? field.args : [];
}

function lastFieldByName(
  type: GraphQLNamedType | null,
  name: string | null,
): GraphQLField<unknown, unknown> | GraphQLInputField | null {
  if (!type || !name) return null;
  return fieldsOf(type)?.[name] ?? null;
}

/** Render a field's type as a short label, e.g. `[Server!]!`. */
function typeLabel(t: { toString(): string }): string {
  return t.toString();
}

/**
 * A CodeMirror completion source driven by the real schema. Suggests, by
 * position: operation keywords, fields of the current type, argument names, and
 * enum / boolean / null values.
 */
export function makeGraphqlCompletion(schema: GraphQLSchema): CompletionSource {
  return (cx) => {
    const word = cx.matchBefore(/[_A-Za-z][_A-Za-z0-9]*/);
    // Only auto-open on an explicit request or while typing an identifier.
    if (!cx.explicit && !word) return null;
    const from = word ? word.from : cx.pos;

    const textBefore = cx.state.doc.sliceString(0, cx.pos);
    const ctx = resolveContext(schema, textBefore);

    const options: Completion[] = [];

    // 1. Value position (after `argName:`) → enum members, booleans, null.
    if (ctx.expectedValueType) {
      if (isEnumType(ctx.expectedValueType)) {
        for (const v of (ctx.expectedValueType as GraphQLEnumType).getValues()) {
          options.push({
            label: v.name,
            type: "enum",
            detail: "enum value",
            info: v.description ?? undefined,
          });
        }
      }
      for (const kw of VALUE_KEYWORDS) {
        options.push({ label: kw, type: "keyword" });
      }
      return options.length
        ? { from, options, validFor: /^[_A-Za-z0-9]*$/ }
        : null;
    }

    // 2. Argument-name position → the field's argument names (minus any already
    // written in this `( … )` list).
    if (ctx.inArgs && ctx.argField) {
      for (const arg of argsOf(ctx.argField)) {
        if (ctx.usedArgs.has(arg.name)) continue;
        options.push({
          label: arg.name,
          type: "property",
          detail: typeLabel(arg.type),
          info: arg.description ?? undefined,
          apply: `${arg.name}: `,
        });
      }
      return options.length
        ? { from, options, validFor: /^[_A-Za-z0-9]*$/ }
        : null;
    }

    // 3. Top level (no braces yet) → operation keywords.
    if (ctx.atTopLevel) {
      for (const kw of OPERATION_KEYWORDS) {
        options.push({
          label: kw,
          type: "keyword",
          detail: "operation",
          apply: kw === "fragment" ? "fragment " : `${kw} {\n  \n}`,
        });
      }
    }

    // 4. Selection set → the fields valid on the current type, minus any field
    // already selected at this level.
    const fields = fieldsOf(ctx.selectionType);
    if (fields) {
      for (const f of Object.values(fields)) {
        if (ctx.usedFields.has(f.name)) continue;
        const named = getNamedType(f.type);
        const isLeaf = isLeafType(named);
        const hasRequiredArgs = argsOf(f).some(
          (a) => a.type.toString().endsWith("!"),
        );
        // Insert a selection-set body for object fields; args parens when any
        // argument is required, so the next keystroke lands inside them.
        const apply = hasRequiredArgs
          ? `${f.name}()`
          : isLeaf
            ? f.name
            : `${f.name} {\n  \n}`;
        options.push({
          label: f.name,
          type: isLeaf ? "property" : "method",
          detail: typeLabel(f.type),
          info: f.description ?? undefined,
          apply,
        });
      }
    }

    // 5. Introspection meta-field, valid inside a selection set (unless present).
    if (fields && !ctx.usedFields.has("__typename")) {
      options.push({
        label: "__typename",
        type: "property",
        detail: "String!",
        info: "The name of the current object type.",
      });
    }

    return options.length
      ? { from, options, validFor: /^[_A-Za-z0-9]*$/ }
      : null;
  };
}
