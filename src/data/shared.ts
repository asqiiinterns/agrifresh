// Identical requests started at the same time (home tiles, the « À décider » badge, the decision board)
// share one network call. Only requests still in flight are shared: a later call always reloads.
const inFlight = new Map<string, Promise<unknown>>();

export function shared<T>(key: string, load: () => Promise<T>): Promise<T> {
  let promise = inFlight.get(key) as Promise<T> | undefined;
  if (!promise) {
    const started: Promise<T> = load().finally(() => { if (inFlight.get(key) === started) inFlight.delete(key); });
    inFlight.set(key, started);
    promise = started;
  }
  // Each caller gets its own copy of a list, so sorting it on one screen does not affect another.
  return promise.then((value) => (Array.isArray(value) ? [...value] : value) as T);
}

// After signing in or changing space, a request started for the previous space must not be reused.
export const clearShared = () => inFlight.clear();
