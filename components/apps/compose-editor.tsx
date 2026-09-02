"use client";

import * as React from "react";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  placeholder as cmPlaceholder,
} from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { indentOnInput, bracketMatching } from "@codemirror/language";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import {
  autocompletion,
  completionKeymap,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { lintCompose, type LintDiagnostic } from "@/lib/deploy/compose-lint";
import { imageCompletionSource } from "@/components/apps/compose-image-complete";
import {
  deploSyntaxHighlighting,
  deploTheme,
  yamlExtensions,
} from "@/components/apps/editor-theme";

/**
 * CodeMirror-based docker-compose editor with live, client-side linting.
 */

/** Convert one Deplo lint diagnostic to a CodeMirror Diagnostic with offsets. */
function toCmDiagnostic(
  view: EditorView,
  d: LintDiagnostic,
): Diagnostic | null {
  const doc = view.state.doc;
  const lineNo = Math.min(Math.max(d.line, 1), doc.lines);
  const line = doc.line(lineNo);
  // Highlight the whole line (minus leading indent) when no column, else from
  // the column to end of line - enough to make the marker findable.
  const from = d.column
    ? Math.min(line.from + d.column - 1, line.to)
    : line.from;
  return {
    from,
    to: line.to,
    severity: d.severity,
    message: d.message,
    source: d.rule,
  };
}

const composeLinter = linter(
  (view) => {
    const source = view.state.doc.toString();
    const diags = lintCompose(source);
    return diags
      .map((d) => toCmDiagnostic(view, d))
      .filter((d): d is Diagnostic => d !== null);
  },
  { delay: 250 },
);

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
  placeholder = 'services:\n  app:\n    image: nginx:1.27\n    ports:\n      - "8080:80"',
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
        ...yamlExtensions(),
        deploSyntaxHighlighting,
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
