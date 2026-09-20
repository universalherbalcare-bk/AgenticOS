"""Durable, multi-process-safe turn idempotency.

The default ``IdempotencyStore`` is an in-process dict: correct for one uvicorn
worker, silently wrong for two — a redelivered turn that lands on the other
worker executes twice. That is a correctness hole and a scale ceiling in one.

This store keeps the same two-method interface (``claim`` / ``release``) and
backs it with SQLite:

  * **Atomic claim.** ``INSERT`` into a table whose primary key is ``turn_id``;
    a second inserter of the same key hits the constraint and loses. No
    read-then-write race, no lock held in Python.
  * **Cross-process.** WAL journal mode so many workers (and the brain's own
    Agno db, if co-located) read/write concurrently without ``database is
    locked`` storms; ``busy_timeout`` absorbs brief contention.
  * **TTL by expiry column,** swept opportunistically on claim, so a crashed
    worker's claims are not held forever.
  * **Release** deletes the row so a genuinely failed turn may be retried —
    the same semantic the in-memory store has.

sqlite3 calls are synchronous; they are short (single-row DML) and run in a
worker thread via ``asyncio.to_thread`` so the event loop is never blocked.
"""

from __future__ import annotations

import asyncio
import sqlite3
import time
from pathlib import Path
from typing import Optional

_SCHEMA = """
CREATE TABLE IF NOT EXISTS bridge_turn_claims (
    turn_id     TEXT PRIMARY KEY,
    claimed_at  REAL NOT NULL,
    expires_at  REAL NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS bridge_turn_claims_expires ON bridge_turn_claims (expires_at);
"""


class SqliteIdempotencyStore:
    def __init__(
        self,
        db_file: str | Path,
        *,
        ttl_seconds: int = 3600,
        busy_timeout_ms: int = 5000,
    ) -> None:
        self._path = str(db_file)
        self._ttl = float(ttl_seconds)
        self._busy_ms = int(busy_timeout_ms)
        self._init_lock = asyncio.Lock()
        self._ready = False
        Path(self._path).parent.mkdir(parents=True, exist_ok=True)

    # -- interface (identical to IdempotencyStore) ----------------------------

    async def claim(self, turn_id: str) -> bool:
        await self._ensure()
        return await asyncio.to_thread(self._claim_sync, turn_id, time.time())

    async def release(self, turn_id: str) -> None:
        await self._ensure()
        await asyncio.to_thread(self._release_sync, turn_id)

    # -- internals ------------------------------------------------------------

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._path, timeout=self._busy_ms / 1000, isolation_level=None)
        # ORDER MATTERS. busy_timeout must be set BEFORE journal_mode: switching a
        # fresh database to WAL takes an exclusive lock, and with no busy timeout
        # yet installed that PRAGMA raised "database is locked" the instant several
        # processes cold-started against the same file (4 workers x 25 claims
        # reproduced it under a clean environment). Installing the timeout first
        # makes the WAL switch wait like every other write.
        conn.execute(f"PRAGMA busy_timeout={self._busy_ms}")
        _retry_locked(lambda: conn.execute("PRAGMA journal_mode=WAL"))
        conn.execute("PRAGMA synchronous=NORMAL")
        return conn

    async def _ensure(self) -> None:
        if self._ready:
            return
        async with self._init_lock:
            if self._ready:
                return
            await asyncio.to_thread(self._init_sync)
            self._ready = True

    def _init_sync(self) -> None:
        conn = self._connect()
        try:
            _retry_locked(lambda: conn.executescript(_SCHEMA))
        finally:
            conn.close()

    def _claim_sync(self, turn_id: str, now: float) -> bool:
        conn = self._connect()
        try:
            # Opportunistic sweep of expired claims; cheap because of the index.
            _retry_locked(lambda: conn.execute("DELETE FROM bridge_turn_claims WHERE expires_at <= ?", (now,)))
            try:
                _retry_locked(
                    lambda: conn.execute(
                        "INSERT INTO bridge_turn_claims (turn_id, claimed_at, expires_at) VALUES (?, ?, ?)",
                        (turn_id, now, now + self._ttl),
                    )
                )
                return True
            except sqlite3.IntegrityError:
                return False  # someone else owns this turn_id
        finally:
            conn.close()

    def _release_sync(self, turn_id: str) -> None:
        conn = self._connect()
        try:
            _retry_locked(lambda: conn.execute("DELETE FROM bridge_turn_claims WHERE turn_id = ?", (turn_id,)))
        finally:
            conn.close()

    # Observability hook for doctor/tests; not part of the bridge interface.
    def active_claims(self) -> int:
        conn = self._connect()
        try:
            row: Optional[tuple] = conn.execute(
                "SELECT COUNT(*) FROM bridge_turn_claims WHERE expires_at > ?", (time.time(),)
            ).fetchone()
            return int(row[0]) if row else 0
        finally:
            conn.close()


def _retry_locked(fn, *, budget_s: float = 3.0):
    """Bounded, jittered retry for SQLITE_BUSY/LOCKED.

    busy_timeout covers most contention, but a few operations (the WAL switch,
    schema creation, and the rare lock upgrade) can still surface
    "database is locked" under a cold-start stampede. Retrying with jitter for a
    bounded budget turns that into a short wait; after the budget the error is
    raised unchanged so a genuinely stuck database is never silently ignored.
    IntegrityError (the *intended* loser signal) is never retried.
    """
    import random

    deadline = time.monotonic() + budget_s
    delay = 0.005
    while True:
        try:
            return fn()
        except sqlite3.OperationalError as exc:
            msg = str(exc).lower()
            if ("locked" not in msg and "busy" not in msg) or time.monotonic() >= deadline:
                raise
            time.sleep(delay + random.uniform(0, delay))
            delay = min(delay * 2, 0.1)


__all__ = ["SqliteIdempotencyStore"]
