/**
 * One task at a time per key (a note, a file), other keys run freely. Used where a check and the
 * write that follows it must not be interleaved with another request for the same thing.
 */
export function createKeyedLock(): <T>(key: string, task: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return async function run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.catch(() => undefined);
    tails.set(key, tail);
    try {
      return await result;
    } finally {
      // Forget the key when nobody queued behind this task.
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}
