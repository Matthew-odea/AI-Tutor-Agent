/**
 * Tests for formatTime utilities
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { formatRelativeTime } from "./formatTime";

describe("formatTime utilities", () => {
  beforeEach(() => {
    // Mock current time
    vi.setSystemTime(new Date("2024-01-15T12:00:00Z"));
  });

  describe("formatRelativeTime", () => {
    it('should return "Just now" for very recent timestamps', () => {
      const timestamp = new Date("2024-01-15T11:59:30Z").toISOString();
      const result = formatRelativeTime(timestamp);
      expect(result).toBe("Just now");
    });

    it("should format minutes ago", () => {
      const timestamp = new Date("2024-01-15T11:45:00Z").toISOString();
      const result = formatRelativeTime(timestamp);
      expect(result).toBe("15m ago");
    });

    it("should format hours ago", () => {
      const timestamp = new Date("2024-01-15T10:00:00Z").toISOString();
      const result = formatRelativeTime(timestamp);
      expect(result).toBe("2h ago");
    });

    it('should return "Yesterday" for yesterday', () => {
      const timestamp = new Date("2024-01-14T12:00:00Z").toISOString();
      const result = formatRelativeTime(timestamp);
      expect(result).toBe("Yesterday");
    });

    it("should format days ago", () => {
      const timestamp = new Date("2024-01-12T12:00:00Z").toISOString();
      const result = formatRelativeTime(timestamp);
      expect(result).toBe("3d ago");
    });

    it("should format weeks ago", () => {
      const timestamp = new Date("2024-01-01T12:00:00Z").toISOString();
      const result = formatRelativeTime(timestamp);
      expect(result).toBe("2w ago");
    });

    it("should format old dates as month and day", () => {
      const timestamp = new Date("2023-12-01T12:00:00Z").toISOString();
      const result = formatRelativeTime(timestamp);
      expect(result).toMatch(/Dec\s1/);
    });

    it("should include year for dates from different year", () => {
      const timestamp = new Date("2023-01-15T12:00:00Z").toISOString();
      const result = formatRelativeTime(timestamp);
      expect(result).toContain("2023");
    });
  });
});
