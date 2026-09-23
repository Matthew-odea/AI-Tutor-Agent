/**
 * Time formatting utilities for relative timestamps
 */

/**
 * Format a timestamp as relative time with abbreviated units
 *
 * @param timestamp - ISO 8601 timestamp string
 * @returns Concise relative time string:
 *   - < 1 minute: "Just now"
 *   - < 1 hour: "15m ago"
 *   - < 24 hours: "3h ago"
 *   - 1 day: "Yesterday"
 *   - < 7 days: "3d ago"
 *   - < 30 days: "2w ago"
 *   - Older: "Jan 15" or "Jan 15, 2023"
 *
 * @example
 * ```ts
 * formatRelativeTime('2024-01-15T10:30:00Z')
 * // => "2h ago" (if current time is 12:30 PM)
 *
 * formatRelativeTime('2024-01-14T10:00:00Z')
 * // => "Yesterday" (if current date is Jan 15)
 * ```
 */
export const formatRelativeTime = (timestamp: string): string => {
  const now = new Date();
  const date = new Date(timestamp);
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;

  // For older dates, show formatted date
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
};

/**
 * Format a timestamp as a full localized date and time string
 *
 * @param timestamp - ISO 8601 timestamp string
 * @returns Localized date-time format (e.g., "Jan 15, 2024, 3:45 PM")
 *
 * @example
 * ```ts
 * formatFullDateTime('2024-01-15T15:45:00Z')
 * // => "Jan 15, 2024, 3:45 PM"
 * ```
 */
export const formatFullDateTime = (timestamp: string): string => {
  const date = new Date(timestamp);
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
};
