"use client";

import * as React from "react";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
} from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { indentOnInput, bracketMatching } from "@codemirror/language";
import type { EditorLanguage } from "@/components/apps/editor-language";
import {
  deploSyntaxHighlighting,
  deploTheme,
  EDITOR_MAX_HEIGHT,
  yamlExtensions,
} from "@/components/apps/editor-theme";

/**
 * A CodeMirror editor on the dashboard's theme - an app's config files, a
 * database's, and read-only YAML previews. `language` null keeps it plain text.
 */
export function TextEditor({
  value,
  onChange,
  readOnly = false,
  minHeight = 360,
  maxHeight = EDITOR_MAX_HEIGHT,
  language = null,
}: {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  minHeight?: number;
  maxHeight?: string;
  language?: EditorLanguage | null;
}) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const viewRef = React.useRef<EditorView | null>(null);
  const onChangeRef = React.useRef(onChange);
  React.useEffect(() => {
    onChangeRef.current = onChange;
  });

  React.useEffect(() => {
    if (!hostRef.current) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) onChangeRef.current(update.state.doc.toString());
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
        ...(language === "yaml" ? yamlExtensions() : []),
        deploSyntaxHighlighting,
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.theme({
          "&": { maxHeight },
          ".cm-scroller": { minHeight: `${minHeight}px`, overflow: "auto" },
        }),
        deploTheme,
        EditorView.lineWrapping,
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        updateListener,
      ],
    });

    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Rebuild only when read-only or the language flips; value sync is below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, language]);

  // Push controlled value changes in from outside (e.g. opening a new file)
  // without clobbering the user's cursor while they type the same value back.
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
