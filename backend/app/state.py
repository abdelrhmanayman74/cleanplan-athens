"""In-memory plan state: shared caches plus one small state per visitor session.

The public demo is used by many visitors at once, so what-ifs must not leak between them. Each
browser tab sends a random `X-Session-Id`; the store keeps a bounded LRU of per-session states
(dataset, plan, params, new-building counter), created lazily from the cached default plan.

Plans and datasets are treated as immutable values: the solver and the what-if operations always
return new objects. A fresh session therefore just points at the shared default plan and costs
nothing until its first change.

The default plan and its baseline are cached in data/ so that startup is instant. The cache is
keyed by a fingerprint of the dataset and the solver version and is recomputed when either changes.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path

from app.data import DATA_DIR, Dataset, load_dataset
from app.geocoder import AddressIndex
from app.solver.baseline import solve_baseline
from app.solver.optimizer import solve_plan
from app.solver.plan import Params
from app.solver.whatif import suggest_absence
from app.travel import HaversineProvider, TravelTimeProvider, provider_from_env

SOLVER_VERSION = "1.0"
MAX_SESSIONS = 200
SESSION_TTL_SECONDS = 2 * 3600
MAX_BASELINES = 64
SESSION_ID_RE = re.compile(r"^[A-Za-z0-9-]{8,64}$")
DEMO_ABSENCE_DAY = "A-Tue"
# Where caches go when data/ is read-only (e.g. a container running as a non-root user).
FALLBACK_CACHE_DIR = Path(os.environ.get("CLEANPLAN_CACHE_DIR", Path(tempfile.gettempdir()) / "cleanplan"))


def dataset_fingerprint(data_dir: Path) -> str:
    h = hashlib.sha1(SOLVER_VERSION.encode())
    for name in ("buildings.json", "stations.json", "meta.json"):
        h.update((data_dir / name).read_bytes())
    h.update(str((data_dir / "matrix.npy").stat().st_size).encode())
    return h.hexdigest()[:12]


class SolverBusy(RuntimeError):
    """A full re-solve is already running (only one at a time, server-wide)."""


@dataclass(frozen=True)
class PlanState:
    """A consistent snapshot: the plan and the dataset its routes refer to. Never mutated."""

    ds: Dataset
    plan: dict
    params: Params


@dataclass
class Session:
    """One visitor's working copy. Writers hold `lock` and replace `state` as a whole."""

    id: str | None
    state: PlanState
    new_buildings: int = 0
    lock: threading.Lock = field(default_factory=threading.Lock)
    last_used: float = field(default_factory=time.monotonic)

    def next_building_id(self) -> str:
        self.new_buildings += 1
        return f"n{self.new_buildings:03d}"


class PlanStore:
    def __init__(
        self,
        data_dir: Path = DATA_DIR,
        log=print,
        max_sessions: int = MAX_SESSIONS,
        ttl_seconds: float = SESSION_TTL_SECONDS,
    ):
        self.data_dir = data_dir
        self.log = log
        self.max_sessions = max_sessions
        self.ttl_seconds = ttl_seconds
        # shared, read-only after startup
        self.base_ds = load_dataset(data_dir)
        self.address_index = AddressIndex.load(data_dir / "address_index.json")
        self.fingerprint = dataset_fingerprint(data_dir)
        # travel times for addresses outside the precomputed matrix (what-if insert)
        self.new_point_provider: TravelTimeProvider = provider_from_env(
            HaversineProvider(self.base_ds.haversine.detour_factor, self.base_ds.haversine.speed_mps)
        )
        self.default_plan = self._load_or_solve()
        self.default_state = PlanState(self.base_ds, self.default_plan, Params.from_dict(self.default_plan["params"]))
        self._baselines: OrderedDict[tuple, dict] = OrderedDict()
        self._baseline_lock = threading.Lock()
        self._load_cached_baseline()
        # per-visitor state
        self._sessions: OrderedDict[str, Session] = OrderedDict()
        self._sessions_lock = threading.Lock()
        self._solve_lock = threading.Lock()  # one full solve at a time, server-wide

    # ---- cache ------------------------------------------------------------------------------
    # The caches ship prebuilt in data/ (scripts/precompute_plan.py), so startup never solves and
    # never writes. If they are missing or stale they are rebuilt, and written to data/ when it is
    # writable, else to FALLBACK_CACHE_DIR.
    def _read_cache(self, name: str) -> dict | None:
        for path in (self.data_dir / name, FALLBACK_CACHE_DIR / name):
            if path.exists():
                d = json.loads(path.read_text())
                if d.get("dataset_fingerprint") == self.fingerprint:
                    return d
        return None

    def _write_cache(self, name: str, d: dict) -> None:
        text = json.dumps(d, ensure_ascii=False)
        try:
            (self.data_dir / name).write_text(text)
        except OSError:
            FALLBACK_CACHE_DIR.mkdir(parents=True, exist_ok=True)
            (FALLBACK_CACHE_DIR / name).write_text(text)
            self.log(f"{self.data_dir} is read-only: cached {name} in {FALLBACK_CACHE_DIR}")

    def _load_or_solve(self) -> dict:
        plan = self._read_cache("default_plan.json")
        if plan is not None:
            self.log(f"default plan loaded from cache ({plan['kpis']['cleaners']} cleaners)")
            return plan
        self.log("default plan cache missing or stale: solving …")
        ds = load_dataset(self.data_dir)
        plan = solve_plan(ds, Params(), log=self.log)
        plan["dataset_fingerprint"] = self.fingerprint
        # extra field: the absence the UI offers as a one-click example
        plan["demo_absence"] = suggest_absence(ds, plan, Params(), DEMO_ABSENCE_DAY)
        self._write_cache("default_plan.json", plan)
        return plan

    def _load_cached_baseline(self) -> None:
        st = self.default_state
        key = (st.params, st.plan["kpis"]["cleaners"])
        cached = self._read_cache("baseline.json")
        if cached is None:
            cached = solve_baseline(self.base_ds, st.params, key[1], st.plan["kpis"]["lower_bound_cleaners"])
            cached["dataset_fingerprint"] = self.fingerprint
            self._write_cache("baseline.json", cached)
        self._baselines[key] = {k: v for k, v in cached.items() if k != "dataset_fingerprint"}

    # ---- sessions ---------------------------------------------------------------------------
    @staticmethod
    def valid_session_id(session_id: str) -> bool:
        return bool(SESSION_ID_RE.match(session_id))

    def view(self, session_id: str | None) -> PlanState:
        """State for read-only requests. Unknown or expired sessions see the default plan; nothing
        is created, so a shared route-sheet link never allocates state."""
        if session_id is None:
            return self.default_state
        with self._sessions_lock:
            self._evict_expired()
            s = self._sessions.get(session_id)
            if s is None:
                return self.default_state
            self._touch(s)
            return s.state

    def session(self, session_id: str | None) -> Session:
        """Session for a state-changing request, created on first use. Without an id the caller
        gets an ephemeral session that is discarded after the request."""
        if session_id is None:
            return Session(None, self.default_state)
        with self._sessions_lock:
            self._evict_expired()
            s = self._sessions.get(session_id)
            if s is None:
                s = Session(session_id, self.default_state)
                self._sessions[session_id] = s
                while len(self._sessions) > self.max_sessions:
                    self._sessions.popitem(last=False)
            self._touch(s)
            return s

    @property
    def session_count(self) -> int:
        return len(self._sessions)

    def _touch(self, s: Session) -> None:
        s.last_used = time.monotonic()
        self._sessions.move_to_end(s.id)

    def _evict_expired(self) -> None:
        # LRU order is last-use order, so expired sessions sit at the front
        cutoff = time.monotonic() - self.ttl_seconds
        while self._sessions:
            oldest = next(iter(self._sessions.values()))
            if oldest.last_used >= cutoff:
                break
            self._sessions.popitem(last=False)

    # ---- operations -------------------------------------------------------------------------
    def reset(self, s: Session) -> PlanState:
        with s.lock:
            s.state = self.default_state
            s.new_buildings = 0
            return s.state

    def solve(self, s: Session, params: Params) -> PlanState:
        """Full re-solve (about 10 s of CPU). Raises SolverBusy if another solve is running."""
        if not self._solve_lock.acquire(blocking=False):
            raise SolverBusy("another re-plan is already running")
        try:
            t0 = time.perf_counter()
            ds = load_dataset(self.data_dir)  # a fresh solve drops what-if buildings
            plan = solve_plan(ds, params, log=self.log)
            self.log(f"solved in {time.perf_counter() - t0:.1f}s")
        finally:
            self._solve_lock.release()
        with s.lock:
            s.state = PlanState(ds, plan, params)
            s.new_buildings = 0
            return s.state

    def baseline(self, st: PlanState) -> dict:
        """Naive baseline for the same buildings, params and team size (shared cache)."""
        key = (st.params, st.plan["kpis"]["cleaners"])
        with self._baseline_lock:
            if key not in self._baselines:
                self._baselines[key] = solve_baseline(
                    load_dataset(self.data_dir), st.params, key[1], st.plan["kpis"]["lower_bound_cleaners"]
                )
                while len(self._baselines) > MAX_BASELINES:
                    self._baselines.popitem(last=False)
            self._baselines.move_to_end(key)
            return self._baselines[key]
