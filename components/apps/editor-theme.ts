import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import {
  syntaxTree,
  syntaxHighlighting,
  HighlightStyle,
} from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { yaml as yamlLang } from "@codemirror/lang-yaml";
import { classifyYamlScalar, type YamlScalarKind } from "./editor-language";

/**
 * The lint gutter draws its markers as a `content:` image, which cannot read a
 * CSS variable - so the severity colours are the token values, spelled out.
 * The glyph is black on all three: it has to stay legible on amber.
 */
function markerSvg(content: string): string {
  return `url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">${encodeURIComponent(content)}</svg>')`;
}

const ERROR_MARKER =
  '<circle cx="20" cy="20" r="16" fill="#ff4242"/>' +
  '<path stroke="#000" stroke-width="4.5" stroke-linecap="round" d="M14 14l12 12M26 14L14 26"/>';

const WARNING_MARKER =
  '<path fill="#f5a623" stroke="#f5a623" stroke-width="5" stroke-linejoin="round" d="M20 7L36 33H4Z"/>' +
  '<path fill="#000" d="M17.9 16h4.2l-.7 10h-2.8z"/>' +
  '<circle cx="20" cy="29.5" r="2.1" fill="#000"/>';

const INFO_MARKER =
  '<circle cx="20" cy="20" r="16" fill="#a1a1aa"/>' +
  '<circle cx="20" cy="12.5" r="2.2" fill="#000"/>' +
  '<path fill="#000" d="M17.9 17.5h4.2v12h-4.2z"/>';

/**
 * Shared CodeMirror chrome for the dashboard's editors: Deplo tokens for the
 * frame, VSCode Dark+/Light+ tokens (--code-*) for the syntax.
 */
export const deploTheme = EditorView.theme({
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

  // --- Plain YAML scalars, classified by text (see yamlScalarHighlighter) ---
  ".cm-yamlNumber": { color: "var(--code-number)" },
  ".cm-yamlConstant": { color: "var(--code-constant)" },
  ".cm-yamlString": { color: "var(--code-string)" },

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

  // --- Gutter severity markers, matching ComposeLintSummary's icons ---
  ".cm-lint-marker-error": { content: markerSvg(ERROR_MARKER) },
  ".cm-lint-marker-warning": { content: markerSvg(WARNING_MARKER) },
  ".cm-lint-marker-info": { content: markerSvg(INFO_MARKER) },

  // --- The hover tooltip (was unstyled → white text on white) ---
  ".cm-tooltip": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
    borderRadius: "0.5rem",
    boxShadow: "0 4px 12px color-mix(in srgb, black 15%, transparent)",
    overflow: "hidden",
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

/**
 * Only the tags `@lezer/yaml` actually emits. `content` is left out on purpose:
 * plain scalars are coloured by yamlScalarHighlighter, which can read the text.
 */
export const deploHighlight = HighlightStyle.define([
  {
    tag: [t.definition(t.propertyName), t.propertyName],
    color: "var(--code-key)",
  },
  { tag: [t.string, t.attributeValue], color: "var(--code-string)" },
  { tag: [t.special(t.string), t.keyword], color: "var(--code-keyword)" },
  { tag: [t.labelName, t.typeName], color: "var(--code-type)" },
  {
    tag: [t.comment, t.lineComment, t.blockComment],
    color: "var(--code-comment)",
  },
  {
    tag: [t.meta, t.punctuation, t.separator, t.brace, t.squareBracket],
    color: "var(--code-punctuation)",
  },
]);

const scalarMarks: Record<YamlScalarKind, Decoration> = {
  number: Decoration.mark({ class: "cm-yamlNumber" }),
  constant: Decoration.mark({ class: "cm-yamlConstant" }),
  string: Decoration.mark({ class: "cm-yamlString" }),
};

function scalarDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);
  let lastFrom = -1;
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        // A key is a Literal too, and keeps the property colour instead.
        if (node.name === "Key") return false;
        if (node.name !== "Literal" && node.name !== "BlockLiteralContent")
          return;
        // Straddling nodes come back once per visible range.
        if (node.from <= lastFrom) return;
        const text = view.state.doc.sliceString(node.from, node.to);
        builder.add(node.from, node.to, scalarMarks[classifyYamlScalar(text)]);
        lastFrom = node.from;
      },
    });
  }
  return builder.finish();
}

const yamlScalarHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = scalarDecorations(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = scalarDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** YAML parsing plus the plain-scalar colouring the parser cannot give us. */
export function yamlExtensions(): Extension[] {
  return [yamlLang(), yamlScalarHighlighter];
}

export const deploSyntaxHighlighting = syntaxHighlighting(deploHighlight, {
  fallback: true,
});
