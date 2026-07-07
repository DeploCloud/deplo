"use client";

import * as React from "react";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  placeholder as cmPlaceholder,
  tooltips,
} from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  syntaxHighlighting,
  HighlightStyle,
  indentOnInput,
  bracketMatching,
} from "@codemirror/language";
import { linter, lintGutter } from "@codemirror/lint";
import {
  autocompletion,
  completionKeymap,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import { tags as t } from "@lezer/highlight";
import {
  clientSchemaFrom,
  makeGraphqlLinter,
  makeGraphqlCompletion,
} from "./graphql-language";

/**
 * A small CodeMirror editor for GraphQL, themed to the dashboard CSS variables
 * exactly like the compose editor. There is no `@codemirror/lang-graphql` in the
 * dependency set, so this uses a lightweight regex-free plain editor with the
 * shared neutral highlight style — good enough for the playground (the server
 * validates the document and returns precise errors). Keep the theme in sync
 * with `components/services/compose-editor.tsx`.
 */

const deploTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
    fontSize: "12px",
  },
  "&.cm-editor": { height: "100%", borderRadius: "0.5rem" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    lineHeight: "1.6",
  },
  ".cm-content": { caretColor: "var(--foreground)", padding: "8px 0" },
  ".cm-placeholder": { color: "var(--muted-foreground)", fontStyle: "italic" },
  ".cm-gutters": {
    backgroundColor: "var(--muted)",
    color: "var(--muted-foreground)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px" },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--accent)",
    color: "var(--foreground)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--accent) 45%, transparent)",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
  "&.cm-focused .cm-matchingBracket": {
    backgroundColor: "color-mix(in srgb, var(--ring) 30%, transparent)",
    outline: "1px solid color-mix(in srgb, var(--ring) 60%, transparent)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection":
    {
      backgroundColor: "color-mix(in srgb, var(--ring) 40%, transparent)",
    },

  // --- Diagnostics: error underlines + gutter markers ---
  ".cm-lintRange-error": {
    backgroundImage: "none",
    textDecoration: "underline wavy var(--destructive)",
    textUnderlineOffset: "3px",
  },
  ".cm-lintRange-warning": {
    backgroundImage: "none",
    textDecoration: "underline wavy var(--warning)",
    textUnderlineOffset: "3px",
  },
  ".cm-lint-marker-error": { color: "var(--destructive)" },
  ".cm-lint-marker-warning": { color: "var(--warning)" },

  // --- Diagnostic hover tooltip (unstyled by default → white-on-white) ---
  ".cm-tooltip": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
    borderRadius: "0.5rem",
    boxShadow: "0 4px 12px color-mix(in srgb, black 15%, transparent)",
    overflow: "hidden",
    // Sit above surrounding dashboard chrome (cards, the result panel, the
    // sticky page header) so the hints/diagnostics box is never covered.
    zIndex: "50",
  },
  ".cm-tooltip.cm-tooltip-lint": { padding: "0" },
  ".cm-tooltip .cm-tooltip-lint .cm-diagnostic": {
    padding: "6px 10px",
    margin: "0",
    borderLeftWidth: "3px",
    borderLeftStyle: "solid",
    whiteSpace: "pre-wrap",
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif",
    fontSize: "12px",
    lineHeight: "1.4",
  },
  ".cm-diagnostic-error": { borderLeftColor: "var(--destructive)" },
  ".cm-diagnostic-warning": { borderLeftColor: "var(--warning)" },
  ".cm-diagnosticSource": { color: "var(--muted-foreground)", fontSize: "10px" },

  // --- Autocomplete dropdown (field / arg / enum hints) ---
  ".cm-tooltip.cm-tooltip-autocomplete": {
    backgroundColor: "var(--popover)",
    border: "1px solid var(--border)",
    borderRadius: "0.5rem",
    boxShadow: "0 4px 12px color-mix(in srgb, black 15%, transparent)",
    padding: "4px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: "12px",
    maxHeight: "18rem",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    padding: "3px 8px",
    borderRadius: "0.25rem",
    color: "var(--popover-foreground)",
    display: "flex",
    alignItems: "center",
    gap: "6px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--accent)",
    color: "var(--accent-foreground)",
  },
  ".cm-completionLabel": { flex: "1" },
  ".cm-completionMatchedText": {
    textDecoration: "none",
    color: "var(--primary)",
    fontWeight: "600",
  },
  ".cm-completionDetail": {
    marginLeft: "auto",
    color: "var(--muted-foreground)",
    fontStyle: "normal",
    fontSize: "10px",
  },
  ".cm-completionInfo": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
    borderRadius: "0.5rem",
    padding: "6px 10px",
    fontSize: "11px",
    maxWidth: "20rem",
  },
});

/** Neutral GraphQL highlighting matching the rest of the dashboard. */
const deploHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword], color: "var(--warning)" },
  {
    tag: [t.definition(t.propertyName), t.propertyName],
    color: "var(--foreground)",
    fontWeight: "600",
  },
  { tag: [t.string, t.special(t.string)], color: "var(--success)" },
  { tag: [t.number, t.integer, t.float, t.bool], color: "var(--foreground)" },
  {
    tag: [t.comment, t.lineComment, t.blockComment],
    color: "var(--muted-foreground)",
    fontStyle: "italic",
  },
  { tag: [t.meta, t.punctuation, t.separator], color: "var(--muted-foreground)" },
  { tag: [t.variableName, t.atom], color: "var(--foreground)" },
]);

export interface GraphqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Cmd/Ctrl+Enter handler, e.g. run the operation. */
  onRun?: () => void;
  /**
   * The schema's introspection JSON (from the catalog). When provided, the
   * editor turns on schema-aware validation (squiggles) and autocomplete
   * (fields, args, enum/keyword values). Without it, the editor is a plain
   * highlighted textarea.
   */
  introspection?: unknown;
  placeholder?: string;
  minHeight?: number;
}

export function GraphqlEditor({
  value,
  onChange,
  onRun,
  introspection,
  placeholder = "query { me { username } }",
  minHeight = 320,
}: GraphqlEditorProps) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const viewRef = React.useRef<EditorView | null>(null);
  const onChangeRef = React.useRef(onChange);
  const onRunRef = React.useRef(onRun);
  React.useEffect(() => {
    onChangeRef.current = onChange;
    onRunRef.current = onRun;
  });

  // Rebuild the client schema only when the introspection payload changes.
  const schema = React.useMemo(
    () => (introspection ? clientSchemaFrom(introspection) : null),
    [introspection],
  );

  React.useEffect(() => {
    if (!hostRef.current) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) onChangeRef.current(update.state.doc.toString());
    });

    const runKeymap = keymap.of([
      {
        key: "Mod-Enter",
        run: () => {
          onRunRef.current?.();
          return true;
        },
      },
    ]);

    // Schema-aware language features when an introspection schema is present:
    // live validation (squiggles) + field/arg/value autocomplete.
    const languageExtensions = schema
      ? [
          linter(makeGraphqlLinter(schema), { delay: 300 }),
          lintGutter(),
          autocompletion({
            override: [makeGraphqlCompletion(schema)],
            icons: true,
            activateOnTyping: true,
          }),
        ]
      : [];

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        syntaxHighlighting(deploHighlight, { fallback: true }),
        cmPlaceholder(placeholder),
        // Render tooltips (autocomplete + diagnostics) into <body> with fixed
        // positioning so the host's `overflow-hidden` never clips the hints box
        // and it always layers above surrounding cards/panels.
        tooltips({ position: "fixed", parent: document.body }),
        runKeymap,
        ...languageExtensions,
        keymap.of([
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.theme({ ".cm-scroller": { minHeight: `${minHeight}px` } }),
        EditorView.contentAttributes.of({
          "aria-label": "GraphQL operation editor",
          role: "textbox",
          "aria-multiline": "true",
        }),
        deploTheme,
        EditorView.lineWrapping,
        updateListener,
      ],
    });

    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Rebuild when the schema arrives/changes; value sync handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema]);

  // Push external value changes (e.g. "load this example") into the editor.
  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  }, [value]);

  return (
    <div
      ref={hostRef}
      className="overflow-hidden rounded-lg border border-input"
      style={{ minHeight }}
    />
  );
}
