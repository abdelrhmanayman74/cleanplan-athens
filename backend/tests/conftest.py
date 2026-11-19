import pytest

from app.data import load_dataset
from app.solver.optimizer import solve_plan
from app.solver.plan import Params
from app.solver.routing import shutdown_pool


@pytest.fixture(scope="session")
def ds():
    return load_dataset()


@pytest.fixture(scope="session")
def params():
    return Params()


@pytest.fixture(scope="session")
def plan(ds, params):
    """A fresh full solve (not the cached default plan), shared by the tests."""
    return solve_plan(ds, params, log=lambda *_: None)


@pytest.fixture(scope="session", autouse=True)
def _pool_cleanup():
    yield
    shutdown_pool()
