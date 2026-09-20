"""The bottleneck test: idempotency must hold across PROCESSES, not just tasks."""

from __future__ import annotations

import asyncio
import multiprocessing as mp
import sys

import pytest

from agenticos_bridge.idempotency_sqlite import SqliteIdempotencyStore


def _worker(db_path: str, turn_id: str, attempts: int, q) -> None:
    async def go():
        store = SqliteIdempotencyStore(db_path, ttl_seconds=60)
        results = await asyncio.gather(*[store.claim(turn_id) for _ in range(attempts)])
        return sum(results)

    q.put(asyncio.run(go()))


@pytest.mark.asyncio
async def test_in_process_concurrency_has_exactly_one_winner(tmp_path):
    store = SqliteIdempotencyStore(tmp_path / "i.db")
    wins = sum(await asyncio.gather(*[store.claim("t") for _ in range(100)]))
    assert wins == 1


@pytest.mark.skipif(sys.platform == "win32", reason="fork/spawn semantics differ")
def test_cross_process_concurrency_has_exactly_one_winner(tmp_path):
    """Four OS processes × 25 attempts each on the SAME turn_id -> one 'True' total.

    This is the property the in-memory store cannot provide and the reason a
    second uvicorn worker used to be able to execute a redelivered turn twice.
    """
    db = str(tmp_path / "x.db")
    ctx = mp.get_context("spawn")
    q = ctx.Queue()
    procs = [ctx.Process(target=_worker, args=(db, "shared-turn", 25, q)) for _ in range(4)]
    for p in procs:
        p.start()
    for p in procs:
        p.join(timeout=60)
    totals = [q.get(timeout=5) for _ in procs]
    assert sum(totals) == 1, f"expected exactly one winner across processes, got {totals}"


@pytest.mark.asyncio
async def test_release_allows_retry_and_ttl_expiry_sweeps(tmp_path):
    store = SqliteIdempotencyStore(tmp_path / "r.db", ttl_seconds=1)
    assert await store.claim("a") is True
    assert await store.claim("a") is False
    await store.release("a")
    assert await store.claim("a") is True
    await asyncio.sleep(1.2)
    assert await store.claim("a") is True, "expired claim must be sweepable"
