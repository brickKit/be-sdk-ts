// DataLoader for resolvers (D8): one instance per request (a process-wide one would serve one user's data to
// another), batches no larger than the downstream's batch limit (P7.10).
import DataLoader from "dataloader";

export function createBatchGetLoader<K, V>(
  batchGet: (ids: readonly K[]) => Promise<ArrayLike<V | Error>>,
  opts: { maxBatchSize?: number } = {},
): DataLoader<K, V> {
  return new DataLoader<K, V>(batchGet, { maxBatchSize: opts.maxBatchSize ?? 500, cache: true });
}
