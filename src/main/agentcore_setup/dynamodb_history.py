"""DynamoDB-backed counterpart of HistoryStore (history.py), sharing the chat sessions table."""
from __future__ import annotations
from typing import Any, Dict, List, Optional
from datetime import datetime, timezone
import uuid
import logging
import os

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class DynamoDBHistoryStore:
    def __init__(self, table_name: Optional[str] = None, region: Optional[str] = None):
        self.table_name = table_name or os.getenv('DYNAMODB_TABLE_NAME', 'chat_sessions')
        self.region = region or os.getenv('DYNAMODB_REGION', 'us-east-1')
        self.dynamodb = boto3.resource('dynamodb', region_name=self.region)
        self.table = self.dynamodb.Table(self.table_name)
        logger.info(f"DynamoDBHistoryStore initialized: table={self.table_name}, region={self.region}")

    def _query_all(self, **kwargs: Any) -> List[Dict[str, Any]]:
        """Query following LastEvaluatedKey, since a single page stops at 1MB."""
        items: List[Dict[str, Any]] = []
        while True:
            response = self.table.query(**kwargs)
            items.extend(response.get("Items", []))
            last_key = response.get("LastEvaluatedKey")
            if not last_key:
                return items
            kwargs["ExclusiveStartKey"] = last_key

    def create_workspace(self, title: str, user_id: Optional[str] = None) -> Dict[str, Any]:
        workspace_id = str(uuid.uuid4())
        now = _now_iso()
        item = {
            "PK": f"WORKSPACE#{workspace_id}",
            "SK": "METADATA",
            "workspace_id": workspace_id,
            "title": title,
            "user_id": user_id,
            "created_at": now,
            "last_accessed": now,
        }
        self.table.put_item(Item=item)
        return item

    def get_workspace(self, workspace_id: str) -> Optional[Dict[str, Any]]:
        response = self.table.get_item(Key={"PK": f"WORKSPACE#{workspace_id}", "SK": "METADATA"})
        return response.get("Item")

    def create_view_session(self, workspace_id: str, view_type: str, pedagogy_mode: Optional[str]) -> Dict[str, Any]:
        view_session_id = str(uuid.uuid4())
        now = _now_iso()
        default_title = "New Chat" if view_type == "chat" else "New Session"
        metadata = {
            "PK": f"VIEW#{view_session_id}",
            "SK": "METADATA",
            "view_session_id": view_session_id,
            "workspace_id": workspace_id,
            "view_type": view_type,
            "title": default_title,
            "created_at": now,
            "last_accessed": now,
            "message_count": 0,
            "total_tokens": 0,
            "pedagogy_mode": pedagogy_mode,
        }
        index_item = {
            "PK": f"WORKSPACE#{workspace_id}",
            "SK": f"VIEW#{view_type}#{view_session_id}",
            "view_session_id": view_session_id,
            "workspace_id": workspace_id,
            "view_type": view_type,
            "title": default_title,
            "created_at": now,
            "last_accessed": now,
            "message_count": 0,
            "total_tokens": 0,
            "pedagogy_mode": pedagogy_mode,
        }
        self.table.put_item(Item=metadata)
        self.table.put_item(Item=index_item)
        return metadata

    def get_view_session(self, view_session_id: str) -> Optional[Dict[str, Any]]:
        response = self.table.get_item(Key={"PK": f"VIEW#{view_session_id}", "SK": "METADATA"})
        return response.get("Item")

    def update_view_title(self, view_session_id: str, title: str) -> Dict[str, Any]:
        expr_vals = {":title": title, ":la": _now_iso()}
        response = self.table.update_item(
            Key={"PK": f"VIEW#{view_session_id}", "SK": "METADATA"},
            UpdateExpression="SET title = :title, last_accessed = :la",
            ExpressionAttributeValues=expr_vals,
            ReturnValues="ALL_NEW",
        )
        updated = response.get("Attributes")
        if updated:
            try:
                self.table.update_item(
                    Key={
                        "PK": f"WORKSPACE#{updated['workspace_id']}",
                        "SK": f"VIEW#{updated['view_type']}#{view_session_id}",
                    },
                    UpdateExpression="SET title = :title, last_accessed = :la",
                    ExpressionAttributeValues=expr_vals,
                )
            except ClientError:
                pass
        return updated

    def add_view_message(
        self,
        view_session_id: str,
        role: str,
        content: str,
        tokens: Optional[int] = None,
        context_ids: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        timestamp = _now_iso()
        item = {
            "PK": f"VIEW#{view_session_id}",
            "SK": f"MESSAGE#{timestamp}",
            "role": role,
            "content": content,
            "timestamp": timestamp,
        }
        if tokens is not None:
            item["tokens"] = tokens
        if context_ids is not None:
            item["context_ids"] = context_ids

        self.table.put_item(Item=item)
        self._update_view_metadata(view_session_id, tokens)
        return item

    def _update_view_metadata(self, view_session_id: str, tokens: Optional[int]) -> None:
        now = _now_iso()
        update_expr = "SET last_accessed = :la, message_count = if_not_exists(message_count, :zero) + :inc"
        expr_vals = {":la": now, ":inc": 1, ":zero": 0}
        if tokens is not None:
            update_expr += ", total_tokens = if_not_exists(total_tokens, :zero) + :t"
            expr_vals[":t"] = tokens
        self.table.update_item(
            Key={"PK": f"VIEW#{view_session_id}", "SK": "METADATA"},
            UpdateExpression=update_expr,
            ExpressionAttributeValues=expr_vals,
        )
        try:
            metadata = self.get_view_session(view_session_id)
            if metadata:
                self.table.update_item(
                    Key={"PK": f"WORKSPACE#{metadata['workspace_id']}", "SK": f"VIEW#{metadata['view_type']}#{view_session_id}"},
                    UpdateExpression=update_expr,
                    ExpressionAttributeValues=expr_vals,
                )
        except ClientError:
            pass

    def get_view_history(self, view_session_id: str) -> List[Dict[str, Any]]:
        return self._query_all(
            KeyConditionExpression="PK = :pk AND begins_with(SK, :sk)",
            ExpressionAttributeValues={":pk": f"VIEW#{view_session_id}", ":sk": "MESSAGE#"},
            ScanIndexForward=True,
        )

    def list_view_sessions(self, workspace_id: str, view_type: Optional[str] = None) -> List[Dict[str, Any]]:
        prefix = "VIEW#" if not view_type else f"VIEW#{view_type}#"
        return self._query_all(
            KeyConditionExpression="PK = :pk AND begins_with(SK, :sk)",
            ExpressionAttributeValues={":pk": f"WORKSPACE#{workspace_id}", ":sk": prefix},
            ScanIndexForward=False,
        )

    def delete_view_session(self, view_session_id: str) -> None:
        metadata = self.get_view_session(view_session_id)
        if not metadata:
            return

        self.table.delete_item(Key={"PK": f"VIEW#{view_session_id}", "SK": "METADATA"})

        try:
            self.table.delete_item(
                Key={"PK": f"WORKSPACE#{metadata['workspace_id']}", "SK": f"VIEW#{metadata['view_type']}#{view_session_id}"}
            )
        except ClientError:
            pass

        for item in self._query_all(
            KeyConditionExpression="PK = :pk AND begins_with(SK, :sk)",
            ExpressionAttributeValues={":pk": f"VIEW#{view_session_id}", ":sk": "MESSAGE#"},
        ):
            self.table.delete_item(Key={"PK": item["PK"], "SK": item["SK"]})

    def create_code_memory(self, workspace_id: str, language: str, current_code: str) -> Dict[str, Any]:
        code_memory_id = str(uuid.uuid4())
        now = _now_iso()
        metadata = {
            "PK": f"CODEMEM#{code_memory_id}",
            "SK": "METADATA",
            "code_memory_id": code_memory_id,
            "workspace_id": workspace_id,
            "language": language,
            "current_code": current_code,
            "last_output": None,
            "last_error": None,
            "created_at": now,
            "last_accessed": now,
        }
        self.table.put_item(Item=metadata)
        return metadata

    def update_code_memory(self, code_memory_id: str, current_code: Optional[str], last_output: Optional[str], last_error: Optional[str]) -> Dict[str, Any]:
        update_expr = []
        expr_vals: Dict[str, Any] = {":la": _now_iso()}
        update_expr.append("last_accessed = :la")
        if current_code is not None:
            update_expr.append("current_code = :code")
            expr_vals[":code"] = current_code
        if last_output is not None:
            update_expr.append("last_output = :out")
            expr_vals[":out"] = last_output
        if last_error is not None:
            update_expr.append("last_error = :err")
            expr_vals[":err"] = last_error

        response = self.table.update_item(
            Key={"PK": f"CODEMEM#{code_memory_id}", "SK": "METADATA"},
            UpdateExpression="SET " + ", ".join(update_expr),
            ExpressionAttributeValues=expr_vals,
            ReturnValues="ALL_NEW",
        )
        return response.get("Attributes")

    def get_code_memory(self, code_memory_id: str) -> Optional[Dict[str, Any]]:
        response = self.table.get_item(Key={"PK": f"CODEMEM#{code_memory_id}", "SK": "METADATA"})
        return response.get("Item")

    def create_program(
        self,
        workspace_id: str,
        code_memory_id: str,
        language: str,
        title: str,
        current_code: str,
    ) -> Dict[str, Any]:
        program_id = str(uuid.uuid4())
        now = _now_iso()
        metadata = {
            "PK": f"PROGRAM#{program_id}",
            "SK": "METADATA",
            "program_id": program_id,
            "workspace_id": workspace_id,
            "code_memory_id": code_memory_id,
            "language": language,
            "title": title,
            "current_code": current_code,
            "last_output": None,
            "last_error": None,
            "created_at": now,
            "last_accessed": now,
        }
        index_item = {
            "PK": f"WORKSPACE#{workspace_id}",
            "SK": f"PROGRAM#{program_id}",
            "program_id": program_id,
            "workspace_id": workspace_id,
            "code_memory_id": code_memory_id,
            "language": language,
            "title": title,
            "current_code": current_code,
            "last_output": None,
            "last_error": None,
            "created_at": now,
            "last_accessed": now,
        }
        self.table.put_item(Item=metadata)
        self.table.put_item(Item=index_item)
        return metadata

    def get_program(self, program_id: str) -> Optional[Dict[str, Any]]:
        response = self.table.get_item(Key={"PK": f"PROGRAM#{program_id}", "SK": "METADATA"})
        return response.get("Item")

    def list_programs(self, workspace_id: str) -> List[Dict[str, Any]]:
        return self._query_all(
            KeyConditionExpression="PK = :pk AND begins_with(SK, :sk)",
            ExpressionAttributeValues={":pk": f"WORKSPACE#{workspace_id}", ":sk": "PROGRAM#"},
            ScanIndexForward=True,
        )

    def update_program(
        self,
        program_id: str,
        title: Optional[str],
        current_code: Optional[str],
        last_output: Optional[str],
        last_error: Optional[str],
    ) -> Dict[str, Any]:
        update_expr = []
        expr_vals: Dict[str, Any] = {":la": _now_iso()}
        update_expr.append("last_accessed = :la")
        if title is not None:
            update_expr.append("title = :title")
            expr_vals[":title"] = title
        if current_code is not None:
            update_expr.append("current_code = :code")
            expr_vals[":code"] = current_code
        if last_output is not None:
            update_expr.append("last_output = :out")
            expr_vals[":out"] = last_output
        if last_error is not None:
            update_expr.append("last_error = :err")
            expr_vals[":err"] = last_error

        response = self.table.update_item(
            Key={"PK": f"PROGRAM#{program_id}", "SK": "METADATA"},
            UpdateExpression="SET " + ", ".join(update_expr),
            ExpressionAttributeValues=expr_vals,
            ReturnValues="ALL_NEW",
        )
        updated = response.get("Attributes")
        if updated:
            try:
                self.table.update_item(
                    Key={"PK": f"WORKSPACE#{updated['workspace_id']}", "SK": f"PROGRAM#{program_id}"},
                    UpdateExpression="SET " + ", ".join(update_expr),
                    ExpressionAttributeValues=expr_vals,
                )
            except ClientError:
                pass
        return updated

    def delete_program(self, program_id: str) -> None:
        metadata = self.get_program(program_id)
        self.table.delete_item(Key={"PK": f"PROGRAM#{program_id}", "SK": "METADATA"})
        if metadata:
            try:
                self.table.delete_item(
                    Key={"PK": f"WORKSPACE#{metadata['workspace_id']}", "SK": f"PROGRAM#{program_id}"}
                )
            except ClientError:
                pass

    def create_thread(self, code_memory_id: str, title: str) -> Dict[str, Any]:
        thread_id = str(uuid.uuid4())
        now = _now_iso()
        metadata = {
            "PK": f"THREAD#{thread_id}",
            "SK": "METADATA",
            "thread_id": thread_id,
            "code_memory_id": code_memory_id,
            "title": title,
            "created_at": now,
            "last_accessed": now,
            "message_count": 0,
        }
        index_item = {
            "PK": f"CODEMEM#{code_memory_id}",
            "SK": f"THREAD#{thread_id}",
            "thread_id": thread_id,
            "code_memory_id": code_memory_id,
            "title": title,
            "created_at": now,
            "last_accessed": now,
            "message_count": 0,
        }
        self.table.put_item(Item=metadata)
        self.table.put_item(Item=index_item)
        return metadata

    def add_thread_message(
        self,
        thread_id: str,
        role: str,
        content: str,
        tokens: Optional[int] = None,
        context_ids: Optional[List[str]] = None,
        edit_block: Optional[dict] = None,
    ) -> Dict[str, Any]:
        timestamp = _now_iso()
        item = {
            "PK": f"THREAD#{thread_id}",
            "SK": f"MESSAGE#{timestamp}",
            "role": role,
            "content": content,
            "timestamp": timestamp,
        }
        if tokens is not None:
            item["tokens"] = tokens
        if context_ids is not None:
            item["context_ids"] = context_ids
        if edit_block is not None:
            item["edit_block"] = edit_block

        self.table.put_item(Item=item)
        self._update_thread_metadata(thread_id)
        return item

    def _update_thread_metadata(self, thread_id: str) -> None:
        now = _now_iso()
        update_expr = "SET last_accessed = :la, message_count = if_not_exists(message_count, :zero) + :inc"
        expr_vals = {":la": now, ":inc": 1, ":zero": 0}
        self.table.update_item(
            Key={"PK": f"THREAD#{thread_id}", "SK": "METADATA"},
            UpdateExpression=update_expr,
            ExpressionAttributeValues=expr_vals,
        )
        try:
            metadata = self.get_thread(thread_id)
            if metadata:
                self.table.update_item(
                    Key={"PK": f"CODEMEM#{metadata['code_memory_id']}", "SK": f"THREAD#{thread_id}"},
                    UpdateExpression=update_expr,
                    ExpressionAttributeValues=expr_vals,
                )
        except ClientError:
            pass

    def delete_thread(self, thread_id: str) -> None:
        metadata = self.get_thread(thread_id)
        messages = self._query_all(
            KeyConditionExpression="PK = :pk AND begins_with(SK, :sk)",
            ExpressionAttributeValues={":pk": f"THREAD#{thread_id}", ":sk": "MESSAGE#"},
            ProjectionExpression="PK, SK",
        )
        with self.table.batch_writer() as batch:
            for msg in messages:
                batch.delete_item(Key={"PK": msg["PK"], "SK": msg["SK"]})
        self.table.delete_item(Key={"PK": f"THREAD#{thread_id}", "SK": "METADATA"})
        # CODEMEM# -> THREAD# reverse-index row
        if metadata:
            try:
                self.table.delete_item(
                    Key={"PK": f"CODEMEM#{metadata['code_memory_id']}", "SK": f"THREAD#{thread_id}"}
                )
            except ClientError:
                pass

    def get_thread_history(self, thread_id: str) -> List[Dict[str, Any]]:
        return self._query_all(
            KeyConditionExpression="PK = :pk AND begins_with(SK, :sk)",
            ExpressionAttributeValues={":pk": f"THREAD#{thread_id}", ":sk": "MESSAGE#"},
            ScanIndexForward=True,
        )

    def get_thread(self, thread_id: str) -> Optional[Dict[str, Any]]:
        response = self.table.get_item(Key={"PK": f"THREAD#{thread_id}", "SK": "METADATA"})
        return response.get("Item")

    def update_thread_title(self, thread_id: str, title: str) -> Dict[str, Any]:
        update_expr = "SET title = :title, last_accessed = :la"
        expr_vals = {":title": title, ":la": _now_iso()}
        response = self.table.update_item(
            Key={"PK": f"THREAD#{thread_id}", "SK": "METADATA"},
            UpdateExpression=update_expr,
            ExpressionAttributeValues=expr_vals,
            ReturnValues="ALL_NEW",
        )
        updated = response.get("Attributes")
        if updated:
            try:
                self.table.update_item(
                    Key={"PK": f"CODEMEM#{updated['code_memory_id']}", "SK": f"THREAD#{thread_id}"},
                    UpdateExpression=update_expr,
                    ExpressionAttributeValues=expr_vals,
                )
            except ClientError:
                pass
        return updated

    def list_threads(self, code_memory_id: str) -> List[Dict[str, Any]]:
        return self._query_all(
            KeyConditionExpression="PK = :pk AND begins_with(SK, :sk)",
            ExpressionAttributeValues={":pk": f"CODEMEM#{code_memory_id}", ":sk": "THREAD#"},
            ScanIndexForward=True,
        )
