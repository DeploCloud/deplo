import { cn } from "@/lib/utils";
import { docsUrl, type DocsTopic } from "@/lib/docs";

// DocsLink is a plain <a> with no hooks, so it renders inside a server component and inside a tooltip alike.
export function DocsLink({
  topic,
  label = "Learn more",
  className,
}: {
  topic: DocsTopic;
  label?: string;
  className?: string;
}) {
  return (
    <a
      href={docsUrl(topic)}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "font-medium text-foreground underline underline-offset-2 hover:no-underline",
        className,
      )}
    >
      {label}
    </a>
  );
}
