"use client";

import * as React from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, placeholder as cmPlaceholder } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  syntaxHighlighting,
  HighlightStyle,
  indentOnInput,
  bracketMatching,
} from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { yaml as yamlLang } from "@codemirror/lang-yaml";
import {
  linter,
  lintGutter,
  type Diagnostic,
} from "@codemirror/lint";
import {
  autocompletion,
  completionKeymap,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { lintCompose, type LintDiagnostic } from "@/lib/deploy/compose-lint";
import { imageCompletionSource } from "@/components/apps/compose-image-complete";

/**
 * CodeMirror-based docker-compose editor with live, client-side linting.
 *
 * Linting runs through `lintCompose` (js-yaml + Deplo-aware semantic rules);
 * results are mapped to CodeMirror `Diagnostic`s and shown as squiggles plus
 * gutter markers. The server still validates at deploy time — this is fast
 * feedback, not the source of truth.
 *
 * CodeMirror touches the DOM, so this is a client component that builds the
 * `EditorView` inside `useEffect`; "use client" + the effect is sufficient under
 * Next 16 (no dynamic import with ssr:false needed).
 */

/**
 * Theme bound to the dashboard's CSS variables so it tracks light/dark and
 * matches the surrounding shadcn cards. Covers the editor surface, gutters,
 * selection, the lint gutter markers, the diagnostic underlines AND the hover
 * tooltip (which CodeMirror renders unstyled by default — that was the
 * white-on-white bug).
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

  // --- Diagnostics: underline marks, severity-coloured ---
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
  ".cm-lintRange-info": {
    backgroundImage: "none",
    textDecoration: "underline dotted var(--muted-foreground)",
    textUnderlineOffset: "3px",
  },

  // --- Gutter severity dots ---
  ".cm-lint-marker-error": { color: "var(--destructive)" },
  ".cm-lint-marker-warning": { color: "var(--warning)" },
  ".cm-lint-marker-info": { color: "var(--muted-foreground)" },

  // --- The hover tooltip (was unstyled → white text on white) ---
  ".cm-tooltip": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
    borderRadius: "0.5rem",
    boxShadow:
      "0 4px 12px color-mix(in srgb, black 15%, transparent)",
    overflow: "hidden",
  },
  ".cm-tooltip.cm-tooltip-lint": { padding: "0" },
  ".cm-tooltip .cm-tooltip-lint .cm-diagnostic": {
    padding: "6px 10px",
    margin: "0",
    borderLeftWidth: "3px",
    borderLeftStyle: "solid",
    whiteSpace: "pre-wrap",
    fontFamily:
      "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif",
    fontSize: "12px",
    lineHeight: "1.4",
  },
  ".cm-diagnostic-error": { borderLeftColor: "var(--destructive)" },
  ".cm-diagnostic-warning": { borderLeftColor: "var(--warning)" },
  ".cm-diagnostic-info": { borderLeftColor: "var(--muted-foreground)" },
  ".cm-diagnosticSource": {
    color: "var(--muted-foreground)",
    fontSize: "10px",
  },

  // --- Lint panel (when opened via keymap) ---
  ".cm-panels": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    borderTop: "1px solid var(--border)",
  },

  // --- Autocomplete dropdown (image name / tag suggestions) ---
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
    maxHeight: "16rem",
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
});

/** Syntax highlighting in the site's neutral palette (no clashing brights). */
const deploHighlight = HighlightStyle.define([
  { tag: [t.definition(t.propertyName), t.propertyName], color: "var(--foreground)", fontWeight: "600" },
  { tag: [t.keyword, t.operatorKeyword, t.bool, t.null], color: "var(--warning)" },
  { tag: [t.string, t.special(t.string)], color: "var(--success)" },
  { tag: [t.number, t.integer, t.float], color: "var(--foreground)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: [t.meta, t.punctuation, t.separator], color: "var(--muted-foreground)" },
  { tag: [t.atom, t.variableName], color: "var(--foreground)" },
]);

/** Convert one Deplo lint diagnostic to a CodeMirror Diagnostic with offsets. */
function toCmDiagnostic(view: EditorView, d: LintDiagnostic): Diagnostic | null {
  const doc = view.state.doc;
  const lineNo = Math.min(Math.max(d.line, 1), doc.lines);
  const line = doc.line(lineNo);
  // Highlight the whole line (minus leading indent) when no column, else from
  // the column to end of line — enough to make the marker findable.
  const from = d.column ? Math.min(line.from + d.column - 1, line.to) : line.from;
  return {
    from,
    to: line.to,
    severity: d.severity,
    message: d.message,
    source: d.rule,
  };
}

const composeLinter = linter((view) => {
  const source = view.state.doc.toString();
  const diags = lintCompose(source);
  return diags
    .map((d) => toCmDiagnostic(view, d))
    .filter((d): d is Diagnostic => d !== null);
}, { delay: 250 });

export interface ComposeEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Surfaced so the parent can show a summary / disable save on errors. */
  onDiagnostics?: (diagnostics: LintDiagnostic[]) => void;
  placeholder?: string;
  minHeight?: number;
}

export function ComposeEditor({
  value,
  onChange,
  onDiagnostics,
  placeholder = "services:\n  app:\n    image: nginx:1.27\n    ports:\n      - \"8080:80\"",
  minHeight = 360,
}: ComposeEditorProps) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const viewRef = React.useRef<EditorView | null>(null);
  // Keep the latest callbacks without forcing the editor to rebuild. Updated in
  // an effect (not during render) so the editor reads the current closures.
  const onChangeRef = React.useRef(onChange);
  const onDiagnosticsRef = React.useRef(onDiagnostics);
  React.useEffect(() => {
    onChangeRef.current = onChange;
    onDiagnosticsRef.current = onDiagnostics;
  });

  // A stable Compartment for the height theme, created once.
  const [heightComp] = React.useState(() => new Compartment());

  React.useEffect(() => {
    if (!hostRef.current) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        const next = update.state.doc.toString();
        onChangeRef.current(next);
        onDiagnosticsRef.current?.(lintCompose(next));
      }
    });

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        indentOnInput(),
        bracketMatching(),
        yamlLang(),
        syntaxHighlighting(deploHighlight, { fallback: true }),
        cmPlaceholder(placeholder),
        autocompletion({
          override: [imageCompletionSource as CompletionSource],
          icons: false,
          activateOnTyping: true,
        }),
        composeLinter,
        lintGutter(),
        keymap.of([
          ...completionKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        heightComp.of(
          EditorView.theme({
            ".cm-scroller": { minHeight: `${minHeight}px` },
          }),
        ),
        deploTheme,
        EditorView.lineWrapping,
        updateListener,
      ],
    });

    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    // Emit an initial lint pass so the parent's summary is populated on mount.
    onDiagnosticsRef.current?.(lintCompose(value));

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Build the editor once; external value sync is handled in the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push controlled value changes in from outside (e.g. a reset) without
  // clobbering the user's cursor while they type the same value back.
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
