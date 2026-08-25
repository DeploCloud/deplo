/**
 * A template's screenshots. Every catalogue `images[]` is empty today, so the
 * caller only mounts this when there is something to show; it exists so the day
 * they are published nothing else has to change. Native scroll and snap. */
export function TemplateScreenshots({
  images,
  name,
}: {
  images: string[];
  name: string;
}) {
  return (
    <div className="-mx-1 scrollbar-none flex snap-x snap-mandatory gap-3 overflow-x-auto px-1">
      {images.map((src, i) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={src}
          src={src}
          alt={`${name} screenshot ${i + 1}`}
          loading="lazy"
          className="h-64 w-auto shrink-0 snap-start rounded-lg border border-border object-cover"
        />
      ))}
    </div>
  );
}
