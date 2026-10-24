import os

import pytest


@pytest.fixture(autouse=True, scope='session')
def _cache_dir(tmp_path_factory):
    """Keep the parts index of the test run out of the user cache (one index per session, reused by the tests)."""
    old = os.environ.get('PCBSTUDIO_CACHE')
    os.environ['PCBSTUDIO_CACHE'] = str(tmp_path_factory.mktemp('cache'))
    yield
    if old is None:
        os.environ.pop('PCBSTUDIO_CACHE', None)
    else:
        os.environ['PCBSTUDIO_CACHE'] = old
