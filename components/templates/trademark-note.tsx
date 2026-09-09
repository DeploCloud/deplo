/**
 * The catalogue draws other people's logos and names. One line saying whose they
 * are, on every page that shows them.
 */
export function TrademarkNote() {
  return (
    <div className="border-t border-border pt-6 text-center">
      <p className="text-xs font-medium">Trademarks</p>
      <p className="mx-auto mt-1 max-w-xl text-xs text-muted-foreground">
        Product names and logos belong to their respective owners. Deplo shows
        them to identify the software, which is not an affiliation or an
        endorsement.
      </p>
    </div>
  );
}
