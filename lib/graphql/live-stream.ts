type Track = <P>(source: AsyncIterableIterator<P>) => AsyncIterableIterator<P>;

// An async generator cannot act on return() while it awaits its next ping, so a
// closed tab kept its pubsub listener until one arrived. Wrap the body and pass
// every subscription through `track`: return() closes them and the body ends now.
export function liveStream<T>(
  body: (track: Track) => AsyncGenerator<T>,
): AsyncIterableIterator<T> & {
  return(value?: unknown): Promise<IteratorResult<T>>;
} {
  const sources = new Set<AsyncIterableIterator<unknown>>();
  let closed = false;
  const closeSources = async () => {
    closed = true;
    const open = [...sources];
    sources.clear();
    await Promise.all(open.map((s) => s.return?.()));
  };
  const track: Track = (source) => {
    if (closed) void source.return?.();
    else sources.add(source);
    return source;
  };
  const inner = body(track);
  const self = {
    async next(): Promise<IteratorResult<T>> {
      try {
        const r = await inner.next();
        if (r.done) await closeSources();
        return r;
      } catch (e) {
        await closeSources();
        throw e;
      }
    },
    async return(value?: unknown): Promise<IteratorResult<T>> {
      await closeSources();
      return inner.return(value as never);
    },
    async throw(err?: unknown): Promise<IteratorResult<T>> {
      await closeSources();
      return inner.throw(err);
    },
    [Symbol.asyncIterator]() {
      return self;
    },
  };
  return self;
}

export const MAX_LIVE_KEYS = 200;

// One stream for a whole list, so a page holds one connection however long the list is.
export function liveKeys(keys: readonly string[]): string[] {
  const unique = [...new Set(keys)];
  if (unique.length > MAX_LIVE_KEYS)
    throw new Error(`At most ${MAX_LIVE_KEYS} items per live list`);
  return unique;
}
