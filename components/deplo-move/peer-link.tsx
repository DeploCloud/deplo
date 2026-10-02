// The other Deplo's address, shown without its scheme: a move only ever runs over https.
export function PeerLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="font-medium break-all text-foreground underline underline-offset-2 hover:no-underline"
    >
      {url.replace(/^https?:\/\//, "")}
    </a>
  );
}
