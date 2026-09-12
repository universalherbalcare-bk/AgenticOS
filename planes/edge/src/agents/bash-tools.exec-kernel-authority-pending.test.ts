/**
 * Unit tests for the partitioned, TTL-bounded pending kernel-approval memory
 * (red-team finding C4). Integration coverage through the real exec tool lives in
 * bash-tools.exec.kernel-authority.test.ts ("C4: pending memory is partitioned by principal").
 */
import { describe, expect, it } from "vitest";
import {
  createKernelAuthorityPendingMemory,
  DEFAULT_PENDING_PER_PRINCIPAL_MAX,
  DEFAULT_PENDING_TOTAL_MAX,
  DEFAULT_PENDING_TTL_MS,
} from "./bash-tools.exec-kernel-authority-pending.js";

const FAR_FUTURE = 4102444800000;

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("kernel authority pending memory", () => {
  it("remembers, recalls, forgets, and clears within one partition", () => {
    const memory = createKernelAuthorityPendingMemory({ now: clock().now });
    memory.remember("p1", "k1", "id-1", FAR_FUTURE);
    expect(memory.recall("p1", "k1")).toBe("id-1");
    expect(memory.recall("p2", "k1")).toBeUndefined();
    expect(memory.size()).toBe(1);
    memory.forget("p1", "k1");
    expect(memory.recall("p1", "k1")).toBeUndefined();
    expect(memory.size()).toBe(0);
    memory.remember("p1", "k1", "id-2", FAR_FUTURE);
    memory.clear();
    expect(memory.size()).toBe(0);
    expect(memory.recall("p1", "k1")).toBeUndefined();
  });

  it("re-remembering the same key replaces the id without growing the memory", () => {
    const memory = createKernelAuthorityPendingMemory({ now: clock().now });
    memory.remember("p1", "k1", "id-1", FAR_FUTURE);
    memory.remember("p1", "k1", "id-2", FAR_FUTURE);
    expect(memory.recall("p1", "k1")).toBe("id-2");
    expect(memory.size()).toBe(1);
  });

  it("one principal's churn past its own cap evicts only that principal's oldest entries", () => {
    const memory = createKernelAuthorityPendingMemory({
      perPrincipalMax: 4,
      totalMax: 1000,
      now: clock().now,
    });
    memory.remember("victim", "victim-cmd", "victim-id", FAR_FUTURE);
    for (let i = 0; i < 50; i += 1) {
      memory.remember("attacker", `cmd-${i}`, `id-${i}`, FAR_FUTURE);
    }
    expect(memory.recall("victim", "victim-cmd")).toBe("victim-id");
    expect(memory.partitionSize("attacker")).toBe(4);
    // Insertion-oldest of the attacker's own partition went first.
    expect(memory.recall("attacker", "cmd-0")).toBeUndefined();
    expect(memory.recall("attacker", "cmd-45")).toBeUndefined();
    expect(memory.recall("attacker", "cmd-46")).toBe("id-46");
    expect(memory.recall("attacker", "cmd-49")).toBe("id-49");
    expect(memory.size()).toBe(5);
  });

  it("the overall cap evicts from the LARGEST partition first, so a flooder loses its own entries", () => {
    const memory = createKernelAuthorityPendingMemory({
      perPrincipalMax: 100,
      totalMax: 10,
      now: clock().now,
    });
    memory.remember("victim", "v1", "victim-1", FAR_FUTURE);
    memory.remember("victim", "v2", "victim-2", FAR_FUTURE);
    for (let i = 0; i < 40; i += 1) {
      memory.remember("attacker", `a-${i}`, `id-${i}`, FAR_FUTURE);
    }
    expect(memory.size()).toBe(10);
    expect(memory.partitionSize("victim")).toBe(2);
    expect(memory.partitionSize("attacker")).toBe(8);
    expect(memory.recall("victim", "v1")).toBe("victim-1");
    expect(memory.recall("victim", "v2")).toBe("victim-2");
    expect(memory.recall("attacker", "a-39")).toBe("id-39");
    expect(memory.recall("attacker", "a-0")).toBeUndefined();
  });

  it("entries expire at the kernel's expires_at and are dropped on recall", () => {
    const c = clock();
    const memory = createKernelAuthorityPendingMemory({ now: c.now });
    memory.remember("p1", "k1", "id-1", c.now() + 1000);
    expect(memory.recall("p1", "k1")).toBe("id-1");
    c.advance(999);
    expect(memory.recall("p1", "k1")).toBe("id-1");
    c.advance(1);
    expect(memory.recall("p1", "k1")).toBeUndefined();
    expect(memory.size()).toBe(0);
  });

  it("falls back to the default TTL when the kernel gave no expires_at", () => {
    const c = clock();
    const memory = createKernelAuthorityPendingMemory({ now: c.now, defaultTtlMs: 500 });
    memory.remember("p1", "k1", "id-1", undefined);
    c.advance(499);
    expect(memory.recall("p1", "k1")).toBe("id-1");
    c.advance(1);
    expect(memory.recall("p1", "k1")).toBeUndefined();
  });

  it("never remembers an id the kernel already considers expired", () => {
    const c = clock();
    const memory = createKernelAuthorityPendingMemory({ now: c.now });
    memory.remember("p1", "k1", "id-1", c.now());
    memory.remember("p1", "k2", "id-2", c.now() - 1);
    expect(memory.size()).toBe(0);
    expect(memory.recall("p1", "k1")).toBeUndefined();
  });

  it("sweeps expired entries before evicting live ones when a partition overflows", () => {
    const c = clock();
    const memory = createKernelAuthorityPendingMemory({ perPrincipalMax: 3, now: c.now });
    memory.remember("p1", "stale-1", "s1", c.now() + 10);
    memory.remember("p1", "stale-2", "s2", c.now() + 10);
    memory.remember("p1", "live-1", "l1", FAR_FUTURE);
    c.advance(11);
    memory.remember("p1", "live-2", "l2", FAR_FUTURE);
    expect(memory.recall("p1", "live-1")).toBe("l1");
    expect(memory.recall("p1", "live-2")).toBe("l2");
    expect(memory.partitionSize("p1")).toBe(2);
  });

  it("sweeps expired entries across all partitions before evicting live ones at the overall cap", () => {
    const c = clock();
    const memory = createKernelAuthorityPendingMemory({
      perPrincipalMax: 100,
      totalMax: 4,
      now: c.now,
    });
    memory.remember("stale", "x1", "s1", c.now() + 10);
    memory.remember("stale", "x2", "s2", c.now() + 10);
    memory.remember("stale", "x3", "s3", c.now() + 10);
    memory.remember("live", "y1", "l1", FAR_FUTURE);
    c.advance(11);
    memory.remember("live", "y2", "l2", FAR_FUTURE);
    expect(memory.size()).toBe(2);
    expect(memory.recall("live", "y1")).toBe("l1");
    expect(memory.recall("live", "y2")).toBe("l2");
    expect(memory.partitionSize("stale")).toBe(0);
  });

  it("uses documented defaults and rejects non-positive or non-integer limits", () => {
    expect(DEFAULT_PENDING_PER_PRINCIPAL_MAX).toBe(512);
    expect(DEFAULT_PENDING_TOTAL_MAX).toBe(4096);
    expect(DEFAULT_PENDING_TTL_MS).toBe(15 * 60_000);
    const memory = createKernelAuthorityPendingMemory();
    // The literal red-team PoC (256 distinct fillers from one principal) fits under the
    // per-principal cap, so even a same-principal flood of that size evicts nothing.
    memory.remember("p", "victim", "v", FAR_FUTURE);
    for (let i = 0; i < 256; i += 1) {
      memory.remember("p", `filler-${i}`, `f-${i}`, FAR_FUTURE);
    }
    expect(memory.recall("p", "victim")).toBe("v");
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createKernelAuthorityPendingMemory({ perPrincipalMax: bad })).toThrow(
        /perPrincipalMax/,
      );
      expect(() => createKernelAuthorityPendingMemory({ totalMax: bad })).toThrow(/totalMax/);
      expect(() => createKernelAuthorityPendingMemory({ defaultTtlMs: bad })).toThrow(
        /defaultTtlMs/,
      );
    }
  });
});
