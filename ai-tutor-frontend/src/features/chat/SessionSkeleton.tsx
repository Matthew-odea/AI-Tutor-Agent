/**
 * Skeleton loader for session list items
 */

export const SessionSkeleton = () => (
  <div className="px-3 py-3 animate-pulse">
    <div className="h-4 bg-gray-700 rounded w-3/4 mb-2"></div>
    <div className="h-3 bg-gray-800 rounded w-1/2"></div>
  </div>
);

/**
 * Multiple skeleton loaders for initial load
 */
export const SessionSkeletonList = ({ count = 5 }: { count?: number }) => (
  <>
    {Array.from({ length: count }).map((_, i) => (
      <SessionSkeleton key={i} />
    ))}
  </>
);
