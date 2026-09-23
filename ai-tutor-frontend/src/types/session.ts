/**
 * Type definitions for session-related entities
 */

export interface SessionInfo {
  session_id: string;
  message_count: number;
  created_at: string;
  last_accessed: string;
  total_tokens: number;
  pedagogy_mode?: string;
  title?: string;
}

export interface SessionListResponse {
  sessions: SessionInfo[];
  total: number;
}

export interface ChatHistoryResponse {
  session_id: string;
  messages: Array<{
    role: string;
    content: string;
    timestamp: string;
    tokens?: number;
    context_ids?: string[];
  }>;
  total_messages: number;
  created_at: string;
  last_accessed: string;
  total_tokens: number;
}
