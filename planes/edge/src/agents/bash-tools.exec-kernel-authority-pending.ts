/**
 * Pending kernel-approval memory for the exec kernel authority gate
 * (bash-tools.exec-kernel-authority-gate.ts).
 *
 * Why it exists: without it every exec attempt would propose a NEW kernel
 * approval record and a human's approval of the previous one could never be
 * consumed. With it, the retry after the human says yes presents the
 * remembered id, the kernel consumes it atomically, and the command runs once.
 *
 * Why it is shaped like this (red-team finding C4): a single process-wide
 * count-LRU map let 256 exec calls from ANY principal evict a victim's
 * remembered id (denial-of-approval: the victim pays an extra approval round).
 * This memory is therefore
 *   - partitioned by principal (+ session when known): one principal's churn
 *     evicts only that principal's own entries under `perPrincipalMax`;
 *   - TTL-based first: an entry lives until the kernel's own `expires_at` (or
 *     a default TTL when the kernel gave none) and is swept lazily;
 *   - bounded overall by `totalMax`: when the whole memory overflows, the
 *     oldest entry of the LARGEST partition is evicted, so the flooding
 *     principal loses its own entries before anyone else's.
 * A lost entry only ever costs one extra approval round, never a spawn.
 */

export type KernelAuthorityPendingMemoryOptions = {
  /** Max remembered ids per principal partition; the oldest of that partition goes first. */
  perPrincipalMax?: number;
  /** Max remembered ids across all partitions; the largest partition's oldest goes first. */
  totalMax?: number;
  /** TTL applied when the kernel returned no `expires_at`. */
  defaultTtlMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
};

export type KernelAuthorityPendingMemory = {
  /** The remembered approval id for `key` in `partition`, or undefined (expired entries are dropped). */
  recall(partition: string, key: string): string | undefined;
  /** Remembers `id` until `expiresAt` (epoch ms; falls back to the default TTL when absent). */
  remember(partition: string, key: string, id: string, expiresAt: number | undefined): void;
  forget(partition: string, key: string): void;
  clear(): void;
  /** Live (unexpired as of the last sweep) entry count across all partitions. */
  size(): number;
  /** Live entry count for one partition. */
  partitionSize(partition: string): number;
};

export const DEFAULT_PENDING_PER_PRINCIPAL_MAX = 512;
export const DEFAULT_PENDING_TOTAL_MAX = 4096;
export const DEFAULT_PENDING_TTL_MS = 15 * 60_000;

type PendingEntry = { id: string; expiresAt: number };
type Partition = Map<string, PendingEntry>;

function requirePositiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

export function createKernelAuthorityPendingMemory(
  options: KernelAuthorityPendingMemoryOptions = {},
): KernelAuthorityPendingMemory {
  const perPrincipalMax = requirePositiveInteger(
    options.perPrincipalMax,
    DEFAULT_PENDING_PER_PRINCIPAL_MAX,
    "perPrincipalMax",
  );
  const totalMax = requirePositiveInteger(options.totalMax, DEFAULT_PENDING_TOTAL_MAX, "totalMax");
  const defaultTtlMs = requirePositiveInteger(
    options.defaultTtlMs,
    DEFAULT_PENDING_TTL_MS,
    "defaultTtlMs",
  );
  const now = options.now ?? (() => Date.now());

  const partitions = new Map<string, Partition>();
  let total = 0;

  const dropPartitionIfEmpty = (name: string, partition: Partition): void => {
    if (partition.size === 0) {
      partitions.delete(name);
    }
  };

  const deleteEntry = (name: string, partition: Partition, key: string): boolean => {
    if (!partition.delete(key)) {
      return false;
    }
    total -= 1;
    dropPartitionIfEmpty(name, partition);
    return true;
  };

  const sweepPartition = (name: string, partition: Partition, at: number): void => {
    for (const [key, entry] of partition) {
      if (entry.expiresAt <= at) {
        partition.delete(key);
        total -= 1;
      }
    }
    dropPartitionIfEmpty(name, partition);
  };

  const sweepAll = (at: number): void => {
    // Deleting the current key while iterating a Map is well-defined; no snapshot needed.
    for (const [name, partition] of partitions) {
      sweepPartition(name, partition, at);
    }
  };

  /** Evicts the insertion-oldest entry of `partition`; false when it was already empty. */
  const evictOldest = (name: string, partition: Partition): boolean => {
    const oldest = partition.keys().next();
    if (oldest.done) {
      dropPartitionIfEmpty(name, partition);
      return false;
    }
    return deleteEntry(name, partition, oldest.value);
  };

  const largestPartition = (): [string, Partition] | undefined => {
    let best: [string, Partition] | undefined;
    for (const candidate of partitions) {
      if (!best || candidate[1].size > best[1].size) {
        best = candidate;
      }
    }
    return best;
  };

  return {
    recall(partitionName, key) {
      const partition = partitions.get(partitionName);
      const entry = partition?.get(key);
      if (!partition || !entry) {
        return undefined;
      }
      if (entry.expiresAt <= now()) {
        deleteEntry(partitionName, partition, key);
        return undefined;
      }
      return entry.id;
    },

    remember(partitionName, key, id, expiresAt) {
      const at = now();
      const expiry =
        typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : at + defaultTtlMs;
      const existing = partitions.get(partitionName);
      if (existing) {
        deleteEntry(partitionName, existing, key);
      }
      if (expiry <= at) {
        // Already expired by the kernel's own clock: nothing worth presenting later.
        return;
      }
      let partition = partitions.get(partitionName);
      if (!partition) {
        partition = new Map();
        partitions.set(partitionName, partition);
      }
      partition.set(key, { id, expiresAt: expiry });
      total += 1;

      if (partition.size > perPrincipalMax) {
        // TTL first, then this principal's own oldest: churn never crosses partitions here.
        sweepPartition(partitionName, partition, at);
        while (partition.size > perPrincipalMax && evictOldest(partitionName, partition)) {
          // keep evicting this partition only
        }
      }
      if (total > totalMax) {
        sweepAll(at);
        // `total` is decremented inside evictOldest (via deleteEntry); re-check each round.
        for (;;) {
          if (total <= totalMax) {
            break;
          }
          const largest = largestPartition();
          if (!largest || !evictOldest(largest[0], largest[1])) {
            break;
          }
        }
      }
    },

    forget(partitionName, key) {
      const partition = partitions.get(partitionName);
      if (partition) {
        deleteEntry(partitionName, partition, key);
      }
    },

    clear() {
      partitions.clear();
      total = 0;
    },

    size() {
      return total;
    },

    partitionSize(partitionName) {
      return partitions.get(partitionName)?.size ?? 0;
    },
  };
}
