from __future__ import annotations

import logging
import time
from typing import Any, Dict, List

logger = logging.getLogger(__name__)

BATCH_GET_LIMIT = 100


def batch_get_items(table, keys: List[Dict[str, Any]], *, max_retries: int = 3) -> List[Dict[str, Any]]:
    """BatchGetItem over any number of keys (chunked at DynamoDB's 100-key cap).

    UnprocessedKeys (returned under throttling) are retried with exponential backoff up to
    max_retries times; keys still unprocessed after that are logged and omitted.
    """
    table_name = table.table_name
    client = table.meta.client
    items: List[Dict[str, Any]] = []
    for i in range(0, len(keys), BATCH_GET_LIMIT):
        request_keys = keys[i : i + BATCH_GET_LIMIT]
        attempt = 0
        while request_keys:
            if attempt:
                time.sleep(0.1 * (2 ** (attempt - 1)))
            response = client.batch_get_item(RequestItems={table_name: {"Keys": request_keys}})
            items.extend(response.get("Responses", {}).get(table_name, []))
            request_keys = response.get("UnprocessedKeys", {}).get(table_name, {}).get("Keys", [])
            if request_keys and attempt >= max_retries:
                logger.warning(
                    "batch_get_item on %s: %d keys still unprocessed after %d retries",
                    table_name, len(request_keys), max_retries,
                )
                break
            attempt += 1
    return items
