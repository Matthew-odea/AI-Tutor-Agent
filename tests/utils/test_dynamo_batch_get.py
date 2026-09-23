"""batch_get_items: chunking plus capped, backed-off UnprocessedKeys retries.

The boto3 client is faked (moto never returns UnprocessedKeys) with the real
BatchGetItem response shape.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from src.main.service.InstructorAssessmentResultsAggregator import InstructorAssessmentResultsAggregator
from src.main.utils.DynamoBatchGet import batch_get_items

TABLE = "t"


class _FakeClient:
    """Serves each requested key, but leaves the first `throttle_rounds` responses' keys unprocessed."""

    def __init__(self, throttle_rounds):
        self.throttle_rounds = throttle_rounds
        self.calls = []

    def batch_get_item(self, RequestItems):
        keys = RequestItems[TABLE]["Keys"]
        self.calls.append(keys)
        if self.throttle_rounds is None or len(self.calls) <= self.throttle_rounds:
            return {"Responses": {TABLE: []}, "UnprocessedKeys": {TABLE: {"Keys": keys}}}
        return {"Responses": {TABLE: [dict(k) for k in keys]}, "UnprocessedKeys": {}}


def _table(client):
    return SimpleNamespace(table_name=TABLE, meta=SimpleNamespace(client=client))


def _keys(n):
    return [{"PK": "ASSESSMENT#a-1", "SK": f"STUDENT#s-{i}"} for i in range(n)]


@patch("src.main.utils.DynamoBatchGet.time.sleep")
def test_retries_unprocessed_with_backoff_then_succeeds(sleep):
    client = _FakeClient(throttle_rounds=2)
    items = batch_get_items(_table(client), _keys(3))
    assert len(items) == 3
    assert len(client.calls) == 3
    assert [c.args[0] for c in sleep.call_args_list] == [0.1, 0.2]


@patch("src.main.utils.DynamoBatchGet.time.sleep")
def test_permanent_throttling_is_capped(sleep):
    client = _FakeClient(throttle_rounds=None)
    items = batch_get_items(_table(client), _keys(3), max_retries=3)
    assert items == []
    assert len(client.calls) == 4  # initial + 3 retries, not an infinite loop
    assert sleep.call_count == 3


@patch("src.main.utils.DynamoBatchGet.time.sleep")
def test_chunks_at_100_keys(sleep):
    client = _FakeClient(throttle_rounds=0)
    items = batch_get_items(_table(client), _keys(250))
    assert len(items) == 250
    assert [len(c) for c in client.calls] == [100, 100, 50]
    sleep.assert_not_called()


@patch("src.main.utils.DynamoBatchGet.time.sleep")
def test_results_aggregator_enrollment_fetch_is_capped(sleep):
    client = _FakeClient(throttle_rounds=None)
    agg = InstructorAssessmentResultsAggregator(table=_table(client), get_students=lambda _: [])
    assert agg._batch_get_enrollments("a-1", ["s-0", "s-1"]) == {}
    assert len(client.calls) == 4
