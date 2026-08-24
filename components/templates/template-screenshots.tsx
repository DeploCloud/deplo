/**
 * A template's screenshots.
 *
 * The catalogue carries an `images[]` per entry and today every one of them is
 * empty, so this renders for nobody — the caller only mounts it when there is
 * something to show. It is here so the day the catalogue publishes screenshots
 * they appear without a second pass over this page.
 *
 * Native scroll and snap, same as the store's rails: no carousel, no state, and
 * nothing that needs the client.
 */
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
