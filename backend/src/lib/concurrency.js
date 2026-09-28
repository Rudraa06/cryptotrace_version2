/**
 * lib/concurrency.js
 * ---------------------------------------------------------------------------
 * A tiny promise-concurrency limiter (the `p-limit` pattern, ~40 lines, no
 * dependency).
 *
 * Why we need it: a breadth-first trace produces bursts of work. Hop 2 of a
 * 12-fan-out trace wants to issue 144 RPC calls simultaneously. Fired all at
 * once that guarantees HTTP 429 from Alchemy and, worse, non-deterministic
 * results between demo runs. Capping in-flight calls turns a spiky burst into a
 * steady stream the rate limiter tolerates.
 */

/**
 * Create a limiter that allows at most `maxConcurrent` tasks to run at once.
 *
 * @param {number} maxConcurrent
 * @returns {<T>(task: () => Promise<T>) => Promise<T>} Wrap any thunk with this.
 */
export function createLimiter(maxConcurrent) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new TypeError(`maxConcurrent must be a positive integer, got ${maxConcurrent}`);
  }

  let active = 0;
  /** @type {Array<() => void>} */
  const queue = [];

  /** Release a slot and start the next queued task, if any. */
  const release = () => {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  };

  return function limit(task) {
    return new Promise((resolve, reject) => {
      const run = () => {
        active += 1;
        // Promise.resolve().then keeps sync throws inside the promise chain.
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          // `release` runs regardless of outcome so a rejected task can never
          // leak a permanently-held slot and deadlock the traversal.
          .finally(release);
      };

      if (active < maxConcurrent) run();
      else queue.push(run);
    });
  };
}

/**
 * Map over items with bounded concurrency, preserving input order in the result.
 *
 * Unlike `Promise.all(items.map(...))` this never has more than `limit` tasks in
 * flight. Rejections propagate (fail fast), which is what we want for RPC work:
 * a genuinely dead endpoint should surface immediately, not after 400 timeouts.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} mapper
 * @returns {Promise<R[]>}
 */
export async function mapWithConcurrency(items, limit, mapper) {
  const run = createLimiter(limit);
  return Promise.all(items.map((item, index) => run(() => mapper(item, index))));
}

/**
 * Like `mapWithConcurrency`, but a single failure never sinks the whole batch.
 * Returns a settled-style result per item.
 *
 * Used for the BFS frontier: if one address out of thirty cannot be fetched
 * (deleted contract, upstream hiccup, quota blip) we still want the other
 * twenty-nine hops in the graph. A partial trace is useful evidence; a crashed
 * request is not.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} mapper
 * @returns {Promise<Array<{ status: 'fulfilled', value: R } | { status: 'rejected', reason: unknown }>>}
 */
export async function settleWithConcurrency(items, limit, mapper) {
  const run = createLimiter(limit);
  return Promise.all(
    items.map((item, index) =>
      run(async () => {
        try {
          return { status: 'fulfilled', value: await mapper(item, index) };
        } catch (reason) {
          return { status: 'rejected', reason };
        }
      })
    )
  );
}
