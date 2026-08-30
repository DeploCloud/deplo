// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Markdown from somewhere else - a template description, a release note. Remote
 * input, so no `rehype-raw`: anything HTML-shaped renders as text.
 * Links open in a new tab with `rel="noopener"`. */
export function RemoteMarkdown({ source }: { source: string }) {
  return (
    <div className="space-y-4 text-sm leading-relaxed text-muted-foreground">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h3 className="pt-2 text-base font-semibold text-foreground lg:text-lg">
              {children}
            </h3>
          ),
          h2: ({ children }) => (
            <h3 className="pt-2 text-base font-semibold text-foreground lg:text-lg">
              {children}
            </h3>
          ),
          h3: ({ children }) => (
            <h4 className="pt-1 text-sm font-semibold text-foreground">
              {children}
            </h4>
          ),
          p: ({ children }) => <p>{children}</p>,
          strong: ({ children }) => (
            <strong className="font-semibold text-foreground">
              {children}
            </strong>
          ),
          ul: ({ children }) => (
            <ul className="list-disc space-y-1 pl-5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal space-y-1 pl-5">{children}</ol>
          ),
          code: ({ children }) => (
            <code className="rounded bg-secondary px-1 py-0.5 font-mono text-xs text-foreground">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-xs">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-border pl-3 italic">
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline underline-offset-2 hover:text-foreground/80"
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-border py-1.5 pr-4 text-xs font-medium text-foreground">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-border py-1.5 pr-4 align-top">
              {children}
            </td>
          ),
        }}
      >
        {source}
      </Markdown>
    </div>
  );
}
