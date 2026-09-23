#!/usr/bin/env python3
"""Backfill missing `createdBy` on assessments in DynamoDB. Dry run unless --apply.

  python scripts/backfill_assessment_created_by.py --owner-user-id <user_id> [--assessment-id <id>] [--apply]
"""

from __future__ import annotations

import argparse
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backfill createdBy on legacy assessments")
    parser.add_argument(
        "--owner-user-id",
        required=True,
        help="User ID to set as createdBy for legacy assessments missing ownership",
    )
    parser.add_argument(
        "--assessment-id",
        default=None,
        help="Optional single assessment ID to backfill",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Persist updates. If omitted, script runs in dry-run mode.",
    )
    parser.add_argument(
        "--region",
        default=os.getenv("AWS_DEFAULT_REGION", "us-east-1"),
        help="AWS region (default from AWS_DEFAULT_REGION or us-east-1)",
    )
    parser.add_argument(
        "--table-name",
        default=os.getenv("DYNAMODB_ASSESSMENT_TABLE", "oral_assessments"),
        help="DynamoDB table name (default from DYNAMODB_ASSESSMENT_TABLE or oral_assessments)",
    )
    return parser.parse_args()


def get_table(region: str, table_name: str):
    dynamodb = boto3.resource("dynamodb", region_name=region)
    return dynamodb.Table(table_name)


def query_assessment_metadata_items(table, assessment_id: Optional[str]) -> List[Dict[str, Any]]:
    if assessment_id:
        response = table.get_item(
            Key={
                "PK": f"ASSESSMENT#{assessment_id}",
                "SK": "METADATA",
            }
        )
        item = response.get("Item")
        return [item] if item else []

    items: List[Dict[str, Any]] = []
    last_evaluated_key = None

    while True:
        query_kwargs = {
            "IndexName": "GSI1",
            "KeyConditionExpression": Key("GSI1PK").eq("ASSESSMENT"),
            "ScanIndexForward": False,
        }
        if last_evaluated_key:
            query_kwargs["ExclusiveStartKey"] = last_evaluated_key

        response = table.query(**query_kwargs)
        for item in response.get("Items", []):
            if item.get("SK") == "METADATA":
                items.append(item)

        last_evaluated_key = response.get("LastEvaluatedKey")
        if not last_evaluated_key:
            break

    return items


def needs_backfill(item: Dict[str, Any]) -> bool:
    created_by = item.get("createdBy")
    return created_by is None or str(created_by).strip() == ""


def apply_backfill(table, assessment_id: str, owner_user_id: str) -> bool:
    now_iso = datetime.now(timezone.utc).isoformat()
    try:
        table.update_item(
            Key={
                "PK": f"ASSESSMENT#{assessment_id}",
                "SK": "METADATA",
            },
            UpdateExpression="SET createdBy = :owner, updatedAt = :updated_at",
            ConditionExpression="attribute_not_exists(createdBy) OR createdBy = :empty",
            ExpressionAttributeValues={
                ":owner": owner_user_id,
                ":updated_at": now_iso,
                ":empty": "",
            },
        )
        return True
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "Unknown")
        if code == "ConditionalCheckFailedException":
            return False
        raise


def main() -> int:
    args = parse_args()

    print("=" * 80)
    print("Backfill Assessment createdBy")
    print("=" * 80)
    print(f"Mode: {'APPLY' if args.apply else 'DRY RUN'}")
    print(f"Region: {args.region}")
    print(f"Table: {args.table_name}")
    print(f"Target owner_user_id: {args.owner_user_id}")
    if args.assessment_id:
        print(f"Target assessment_id: {args.assessment_id}")
    print("=" * 80)

    try:
        table = get_table(args.region, args.table_name)
        items = query_assessment_metadata_items(table, args.assessment_id)

        if not items:
            print("No matching assessment metadata records found.")
            return 0

        targets = [item for item in items if needs_backfill(item)]

        print(f"Scanned assessment metadata records: {len(items)}")
        print(f"Records missing createdBy: {len(targets)}")

        if not targets:
            print("Nothing to backfill.")
            return 0

        updated = 0
        skipped = 0

        for item in targets:
            assessment_id = item.get("id") or item.get("PK", "").replace("ASSESSMENT#", "")
            print(f"- Assessment {assessment_id}: createdBy missing")

            if not args.apply:
                continue

            changed = apply_backfill(table, assessment_id, args.owner_user_id)
            if changed:
                updated += 1
                print("  -> updated")
            else:
                skipped += 1
                print("  -> skipped (record changed concurrently)")

        print("=" * 80)
        if args.apply:
            print(f"Updated: {updated}")
            print(f"Skipped: {skipped}")
        else:
            print("Dry run complete. Re-run with --apply to persist changes.")
        print("=" * 80)
        return 0

    except ClientError as exc:
        message = exc.response.get("Error", {}).get("Message", str(exc))
        print(f"DynamoDB error: {message}")
        return 1
    except Exception as exc:
        print(f"Unexpected error: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
