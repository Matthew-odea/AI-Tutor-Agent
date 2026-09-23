from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import boto3


logger = logging.getLogger(__name__)


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _iso_now() -> str:
    return _now_utc().isoformat()


def _safe_date_prefix(ts: str) -> str:
    try:
        parsed = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return parsed.astimezone(timezone.utc).strftime("%Y-%m-%d")
    except Exception:
        return _now_utc().strftime("%Y-%m-%d")


class AnalyticsService:
    def __init__(self, use_dynamodb: bool = False, table_name: Optional[str] = None, region: Optional[str] = None):
        self.use_dynamodb = use_dynamodb
        self.table_name = table_name or os.getenv("DYNAMODB_TABLE_NAME", "chat_sessions")
        self.region = region or os.getenv("DYNAMODB_REGION", "us-east-1")
        self._events: List[Dict[str, Any]] = []
        self._table = None

        if self.use_dynamodb:
            try:
                dynamodb = boto3.resource("dynamodb", region_name=self.region)
                self._table = dynamodb.Table(self.table_name)
                self._table.load()
            except Exception:
                logger.exception("Failed to initialize analytics DynamoDB table; falling back to in-memory")
                self.use_dynamodb = False
                self._table = None

    def ingest_events(self, user_id: str, events: List[Dict[str, Any]], user_agent: Optional[str] = None) -> int:
        if not events:
            return 0

        accepted = 0
        # Excess events beyond 100 per request are dropped silently
        for raw_event in events[:100]:
            event_name = str(raw_event.get("event_name") or "").strip()
            if not event_name:
                continue

            occurred_at = str(raw_event.get("occurred_at") or _iso_now())
            event = {
                "event_id": str(uuid.uuid4()),
                "event_name": event_name,
                "occurred_at": occurred_at,
                "session_id": raw_event.get("session_id"),
                "app_mode": raw_event.get("app_mode"),
                "properties": raw_event.get("properties") if isinstance(raw_event.get("properties"), dict) else {},
                "user_id": user_id,
                "user_agent": (user_agent or "")[:256],
                "ingested_at": _iso_now(),
            }

            if self.use_dynamodb and self._table is not None:
                date_prefix = _safe_date_prefix(occurred_at)
                self._table.put_item(
                    Item={
                        "PK": f"ANALYTICS#{date_prefix}",
                        "SK": f"EVENT#{event['occurred_at']}#{event['event_id']}",
                        "entity_type": "analytics_event",
                        **event,
                    }
                )
            else:
                self._events.append(event)

            accepted += 1

        return accepted

    def summarize(self, window_days: int = 7) -> Dict[str, Any]:
        bounded_days = max(1, min(window_days, 30))
        cutoff = _now_utc() - timedelta(days=bounded_days)
        events: List[Dict[str, Any]] = []

        if self.use_dynamodb and self._table is not None:
            for i in range(bounded_days):
                day = (_now_utc() - timedelta(days=i)).strftime("%Y-%m-%d")
                response = self._table.query(
                    KeyConditionExpression="PK = :pk AND begins_with(SK, :sk)",
                    ExpressionAttributeValues={
                        ":pk": f"ANALYTICS#{day}",
                        ":sk": "EVENT#",
                    },
                    ScanIndexForward=False,
                )
                events.extend(response.get("Items", []))
        else:
            for event in self._events:
                try:
                    event_ts = datetime.fromisoformat(str(event.get("occurred_at", "")).replace("Z", "+00:00"))
                except Exception:
                    event_ts = _now_utc()
                if event_ts >= cutoff:
                    events.append(event)

        filtered: List[Dict[str, Any]] = []
        for event in events:
            try:
                event_ts = datetime.fromisoformat(str(event.get("occurred_at", "")).replace("Z", "+00:00"))
            except Exception:
                continue
            if event_ts >= cutoff:
                filtered.append(event)

        event_counts: Dict[str, int] = {}
        active_users = set()
        for event in filtered:
            name = str(event.get("event_name") or "unknown")
            event_counts[name] = event_counts.get(name, 0) + 1
            user_id = str(event.get("user_id") or "").strip()
            if user_id:
                active_users.add(user_id)

        return {
            "window_days": bounded_days,
            "total_events": len(filtered),
            "active_users": len(active_users),
            "event_counts": dict(sorted(event_counts.items(), key=lambda item: item[1], reverse=True)),
        }
