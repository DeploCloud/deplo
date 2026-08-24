import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * A template's description, as the catalogue writes it.
 *
 * This is remote input (ADR-0023 §2), so raw HTML stays off: no `rehype-raw`,
 * which means anything HTML-shaped in a description is rendered as text rather
 * than as markup. Links open in a new tab and carry `rel="noopener"` — they
 * point at whatever the catalogue says, and the dashboard is not for it to
 * navigate.
 *
 * Styles are written here rather than through a prose plugin: the repo has no
 * typography plugin and this is the only long-form copy in the product.
 */
export function TemplateMarkdown({ source }: { source: string }) {
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
