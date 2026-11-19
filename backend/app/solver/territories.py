"""Balanced, compact territories (one per cleaner).

1. Weighted k-means gives compact seeds (weight = 2-week workload of a building).
2. Capacitated reassignment as a min-cost flow: every building ships its workload to one of its
   nearest centres, each centre accepts at most its share (+ a small tolerance). Cost = squared
   distance, so the result is a balanced "power diagram": compact regions that do not interleave.
3. Lloyd-style iterations (recompute centroids, re-solve the flow) tighten the regions.
4. Buildings split by the flow go to the centre that received most of their workload, then a
   border-move pass pulls the heaviest/lightest territories back within the tolerance.

Everything is deterministic for a given seed.
"""

from __future__ import annotations

import math
from collections.abc import Callable

import numpy as np
from ortools.graph.python import min_cost_flow
from sklearn.cluster import KMeans

CANDIDATES = 8  # each building may only go to one of its 8 nearest centres


def to_xy(latlng: np.ndarray) -> np.ndarray:
    """Equirectangular projection to metres (accurate enough at city scale)."""
    lat0 = math.radians(float(np.mean(latlng[:, 0])))
    return np.column_stack([latlng[:, 1] * 111_320 * math.cos(lat0), latlng[:, 0] * 110_574])


def _flow_assign(
    xy: np.ndarray, w: np.ndarray, centres: np.ndarray, cap: np.ndarray, n_cand: int = CANDIDATES
) -> np.ndarray:
    n, k = len(xy), len(centres)
    d2 = ((xy[:, None, :] - centres[None, :, :]) ** 2).sum(-1)
    cand = np.argsort(d2, axis=1, kind="stable")[:, : min(n_cand, k)]
    smcf = min_cost_flow.SimpleMinCostFlow()
    src = np.repeat(np.arange(n), cand.shape[1])
    dst = n + cand.ravel()
    cost = np.rint(d2[np.arange(n)[:, None], cand].ravel() / 100).astype(np.int64)
    supply_w = np.rint(w).astype(np.int64)
    arcs = smcf.add_arcs_with_capacity_and_unit_cost(src, dst, np.repeat(supply_w, cand.shape[1]), cost)
    sink = n + k
    smcf.add_arcs_with_capacity_and_unit_cost(
        n + np.arange(k), np.full(k, sink), np.rint(cap).astype(np.int64), np.zeros(k, dtype=np.int64)
    )
    smcf.set_nodes_supplies(np.arange(n), supply_w)
    smcf.set_node_supply(sink, -int(supply_w.sum()))
    status = smcf.solve()
    if status != smcf.OPTIMAL:
        if n_cand < k:  # candidate arcs too restrictive: widen and retry
            return _flow_assign(xy, w, centres, cap, n_cand=k)
        raise RuntimeError(f"territory flow failed: {status}")
    flows = smcf.flows(arcs).reshape(n, -1)
    return cand[np.arange(n), flows.argmax(axis=1)]


def _rebalance(
    xy: np.ndarray, w: np.ndarray, labels: np.ndarray, k: int, tol: float, overhead: np.ndarray, max_moves: int = 400
) -> np.ndarray:
    """Move border buildings out of territories above (1+tol)*mean into the nearest lighter neighbour."""
    labels = labels.copy()
    target = (w.sum() + overhead.sum()) / k
    for _ in range(max_moves):
        loads = np.bincount(labels, weights=w, minlength=k) + overhead
        hi = int(loads.argmax())
        if loads[hi] <= target * (1 + tol):
            break
        members = np.where(labels == hi)[0]
        cents = np.array([xy[labels == c].mean(axis=0) if (labels == c).any() else xy.mean(axis=0) for c in range(k)])
        best = None
        for i in members:
            d_own = np.linalg.norm(xy[i] - cents[hi])
            for c in np.argsort(np.linalg.norm(cents - xy[i], axis=1), kind="stable")[1:4]:
                if loads[c] + w[i] < loads[hi]:
                    score = np.linalg.norm(xy[i] - cents[c]) - d_own
                    if best is None or score < best[0]:
                        best = (score, i, c)
                    break
        if best is None:
            break
        labels[best[1]] = best[2]
    return labels


def balanced_clusters(
    latlng: np.ndarray,
    weights: np.ndarray,
    k: int,
    seed: int = 0,
    tol: float = 0.10,
    iters: int = 6,
    overhead: Callable[[np.ndarray], np.ndarray] | None = None,
) -> np.ndarray:
    """Labels in [0, k): cluster weight (+ optional per-cluster overhead) within about ±tol of the mean.

    `overhead(labels)` returns a fixed extra load per cluster (e.g. walking from the start station);
    capacities are lowered accordingly so territories far from a station get fewer buildings.
    """
    if k <= 1:
        return np.zeros(len(latlng), dtype=int)
    xy = to_xy(np.asarray(latlng, dtype=float))
    w = np.maximum(1.0, np.asarray(weights, dtype=float))
    km = KMeans(n_clusters=k, n_init=4, random_state=seed).fit(xy, sample_weight=w)
    centres = km.cluster_centers_
    labels = km.labels_
    oh = np.zeros(k)
    for _ in range(iters):
        if overhead is not None:
            oh = overhead(labels)
        cap = np.maximum((w.sum() + oh.sum()) / k - oh, w.max()) * 1.01
        labels = _flow_assign(xy, w, centres, cap)
        new = np.array(
            [
                np.average(xy[labels == c], axis=0, weights=w[labels == c]) if (labels == c).any() else centres[c]
                for c in range(k)
            ]
        )
        if np.allclose(new, centres, atol=1.0):
            break
        centres = new
    if overhead is not None:
        oh = overhead(labels)
    labels = _rebalance(xy, w, labels, k, tol, oh)
    # relabel by centroid position (west -> east in 400 m bands, then south -> north): stable, readable ids
    cents = np.array([xy[labels == c].mean(axis=0) for c in range(k)])
    order = np.lexsort((cents[:, 1], np.round(cents[:, 0] / 400)))
    remap = np.empty(k, dtype=int)
    remap[order] = np.arange(k)
    return remap[labels]
