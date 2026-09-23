"""DynamoDB-backed counterpart of ConversationMemory (memory.py)."""
from typing import Any, Dict, List, Optional
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import logging
import os
import json

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)


class DynamoDBConversationMemory:
    """Single-table layout: PK=SESSION#<id>, SK=METADATA | MESSAGE#<iso timestamp>.

    METADATA holds counters, pedagogy_mode, title and a `ttl` epoch for auto-expiry.
    """
    
    def __init__(
        self, 
        table_name: Optional[str] = None,
        region: Optional[str] = None,
        ttl_days: int = 30
    ):
        self.table_name = table_name or os.getenv('DYNAMODB_TABLE_NAME', 'chat_sessions')
        self.region = region or os.getenv('DYNAMODB_REGION', 'us-east-1')
        self.ttl_days = ttl_days
        
        self.dynamodb = boto3.resource('dynamodb', region_name=self.region)
        self.table = self.dynamodb.Table(self.table_name)
        
        logger.info(
            f"DynamoDBConversationMemory initialized: "
            f"table={self.table_name}, region={self.region}, ttl_days={ttl_days}"
        )
    
    def add_message(
        self, 
        session_id: str, 
        role: str, 
        content: str,
        tokens: Optional[int] = None,
        context_ids: Optional[List[str]] = None
    ) -> None:
        timestamp = datetime.now(timezone.utc).isoformat()
        
        try:
            metadata = self._get_metadata(session_id)
            if metadata is None:
                self._create_session(session_id)
                metadata = self._get_metadata(session_id)
            
            message_item = {
                'PK': f'SESSION#{session_id}',
                'SK': f'MESSAGE#{timestamp}',
                'role': role,
                'content': content,
                'timestamp': timestamp
            }
            
            if tokens is not None:
                message_item['tokens'] = tokens
            
            if context_ids is not None:
                message_item['context_ids'] = context_ids
            
            self.table.put_item(Item=message_item)
            
            update_expr = 'SET last_accessed = :la, message_count = message_count + :inc'
            expr_values = {
                ':la': timestamp,
                ':inc': 1
            }
            
            if tokens is not None:
                update_expr += ', total_tokens = total_tokens + :tokens'
                expr_values[':tokens'] = tokens
            
            self.table.update_item(
                Key={
                    'PK': f'SESSION#{session_id}',
                    'SK': 'METADATA'
                },
                UpdateExpression=update_expr,
                ExpressionAttributeValues=expr_values
            )
            
            logger.debug(
                f"Added {role} message to session {session_id[:8]}... "
                f"(tokens: {tokens or 0})"
            )
            
        except ClientError as e:
            logger.error(f"Failed to add message to DynamoDB: {e}")
            raise
    
    def get_history(
        self, 
        session_id: str, 
        max_messages: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """Oldest first; max_messages keeps the most recent N (None = all)."""
        try:
            query_args: Dict[str, Any] = {
                'KeyConditionExpression': 'PK = :pk AND begins_with(SK, :sk)',
                'ExpressionAttributeValues': {
                    ':pk': f'SESSION#{session_id}',
                    ':sk': 'MESSAGE#'
                },
                'ScanIndexForward': True
            }
            items: List[Dict[str, Any]] = []
            # Follow LastEvaluatedKey: one query page stops at 1MB
            while True:
                response = self.table.query(**query_args)
                items.extend(response.get('Items', []))
                last_key = response.get('LastEvaluatedKey')
                if not last_key:
                    break
                query_args['ExclusiveStartKey'] = last_key
            
            messages = []
            for item in items:
                message = {
                    'role': item['role'],
                    'content': item['content'],
                    'timestamp': item['timestamp']
                }
                
                if 'tokens' in item:
                    message['tokens'] = int(item['tokens'])
                
                if 'context_ids' in item:
                    message['context_ids'] = item['context_ids']
                
                messages.append(message)
            
            if messages:
                self._update_last_accessed(session_id)
            
            if max_messages is not None and max_messages > 0 and len(messages) > max_messages:
                messages = messages[-max_messages:]
            
            logger.debug(f"Retrieved {len(messages)} messages from session {session_id[:8]}...")
            return messages
            
        except ClientError as e:
            logger.error(f"Failed to get history from DynamoDB: {e}")
            return []
    
    def get_formatted_history(
        self, 
        session_id: str, 
        max_messages: Optional[int] = None
    ) -> str:
        history = self.get_history(session_id, max_messages)
        
        if not history:
            return ""
        
        formatted_lines = ["Previous conversation:"]
        for msg in history:
            role_label = "Student" if msg["role"] == "user" else "Tutor"
            formatted_lines.append(f"{role_label}: {msg['content']}")
        
        return "\n".join(formatted_lines)
    
    def session_exists(self, session_id: str) -> bool:
        return self._get_metadata(session_id) is not None
    
    def get_session_info(self, session_id: str) -> Optional[Dict[str, Any]]:
        metadata = self._get_metadata(session_id)
        if metadata is None:
            return None
        
        return {
            'session_id': session_id,
            'message_count': int(metadata.get('message_count', 0)),
            'created_at': metadata.get('created_at'),
            'last_accessed': metadata.get('last_accessed'),
            'total_tokens': int(metadata.get('total_tokens', 0)),
            'pedagogy_mode': metadata.get('pedagogy_mode', 'explanatory'),
            'title': metadata.get('title', 'New Chat')
        }
    
    def get_session_stats(self, session_id: str) -> Dict[str, Any]:
        """Legacy alias of get_session_info returning {} instead of None."""
        info = self.get_session_info(session_id)
        return info if info is not None else {}
    
    def set_pedagogy_mode(self, session_id: str, mode: str) -> None:
        """Creates the session if needed."""
        try:
            if not self.session_exists(session_id):
                self._create_session(session_id)
            
            self.table.update_item(
                Key={
                    'PK': f'SESSION#{session_id}',
                    'SK': 'METADATA'
                },
                UpdateExpression='SET pedagogy_mode = :mode',
                ExpressionAttributeValues={
                    ':mode': mode
                }
            )
            
            logger.debug(f"Set pedagogy mode for session {session_id[:8]}... to '{mode}'")
            
        except ClientError as e:
            logger.error(f"Failed to set pedagogy mode in DynamoDB: {e}")
            raise
    
    def get_pedagogy_mode(self, session_id: str) -> str:
        metadata = self._get_metadata(session_id)
        if metadata is None:
            return 'explanatory'
        
        return metadata.get('pedagogy_mode', 'explanatory')
    
    def _get_metadata(self, session_id: str) -> Optional[Dict[str, Any]]:
        try:
            response = self.table.get_item(
                Key={
                    'PK': f'SESSION#{session_id}',
                    'SK': 'METADATA'
                }
            )
            return response.get('Item')
        except ClientError as e:
            logger.error(f"Failed to get metadata from DynamoDB: {e}")
            return None
    
    def _create_session(self, session_id: str, title: Optional[str] = None) -> None:
        now = datetime.now(timezone.utc).isoformat()
        ttl = int((datetime.now(timezone.utc) + timedelta(days=self.ttl_days)).timestamp())
        
        try:
            self.table.put_item(
                Item={
                    'PK': f'SESSION#{session_id}',
                    'SK': 'METADATA',
                    'created_at': now,
                    'last_accessed': now,
                    'total_tokens': 0,
                    'message_count': 0,
                    'pedagogy_mode': 'explanatory',
                    'title': title or 'New Chat',
                    'ttl': ttl
                }
            )
            logger.info(f"Created new session {session_id[:8]}... (TTL: {self.ttl_days} days)")
        except ClientError as e:
            logger.error(f"Failed to create session in DynamoDB: {e}")
            raise
    
    def _update_last_accessed(self, session_id: str) -> None:
        try:
            self.table.update_item(
                Key={
                    'PK': f'SESSION#{session_id}',
                    'SK': 'METADATA'
                },
                UpdateExpression='SET last_accessed = :la',
                ExpressionAttributeValues={
                    ':la': datetime.now(timezone.utc).isoformat()
                }
            )
        except ClientError as e:
            logger.debug(f"Failed to update last_accessed (non-critical): {e}")
    
    def update_session_title(self, session_id: str, title: str) -> None:
        try:
            self.table.update_item(
                Key={
                    'PK': f'SESSION#{session_id}',
                    'SK': 'METADATA'
                },
                UpdateExpression='SET title = :t',
                ExpressionAttributeValues={
                    ':t': title
                }
            )
            logger.info(f"Updated title for session {session_id[:8]}... to '{title}'")
        except ClientError as e:
            logger.error(f"Failed to update session title: {e}")
    
    # Legacy API kept for older callers
    
    def get_state(self, session_id: str) -> Dict[str, Any]:
        return self.get_session_info(session_id) or {}
    
    def set_state(self, session_id: str, state: Dict[str, Any]):
        """Only ensures the session exists; `state` is ignored."""
        if not self.session_exists(session_id):
            self._create_session(session_id)
