export const MessageSkeleton = () => {
  return (
    <div className="animate-pulse space-y-4 py-4">
      <div className="flex justify-end">
        <div className="max-w-[70%] bg-gray-200 rounded-2xl px-4 py-3">
          <div className="h-4 bg-gray-300 rounded w-48 mb-2"></div>
          <div className="h-4 bg-gray-300 rounded w-32"></div>
        </div>
      </div>

      <div className="flex justify-start">
        <div className="max-w-[85%] bg-gray-200 rounded-2xl px-4 py-3">
          <div className="h-4 bg-gray-300 rounded w-full mb-2"></div>
          <div className="h-4 bg-gray-300 rounded w-5/6 mb-2"></div>
          <div className="h-4 bg-gray-300 rounded w-4/6"></div>
        </div>
      </div>
    </div>
  );
};

export const SessionSkeleton = () => {
  return (
    <div className="animate-pulse space-y-2 p-4">
      {[...Array(5)].map((_, i) => (
        <div
          key={i}
          className="flex items-start space-x-3 p-3 rounded-lg bg-gray-100"
        >
          <div className="flex-shrink-0 w-5 h-5 bg-gray-300 rounded"></div>
          <div className="flex-1 space-y-2">
            <div className="h-4 bg-gray-300 rounded w-3/4"></div>
            <div className="h-3 bg-gray-200 rounded w-1/2"></div>
          </div>
        </div>
      ))}
    </div>
  );
};

export const CardSkeleton = () => {
  return (
    <div className="animate-pulse bg-white rounded-lg shadow p-6">
      <div className="h-6 bg-gray-300 rounded w-1/3 mb-4"></div>
      <div className="space-y-3">
        <div className="h-4 bg-gray-200 rounded w-full"></div>
        <div className="h-4 bg-gray-200 rounded w-5/6"></div>
        <div className="h-4 bg-gray-200 rounded w-4/6"></div>
      </div>
    </div>
  );
};

export const PageSkeleton = () => {
  return (
    <div className="animate-pulse h-screen bg-gray-50 p-4">
      <div className="max-w-7xl mx-auto space-y-4">
        <div className="h-12 bg-gray-300 rounded w-1/4 mb-8"></div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      </div>
    </div>
  );
};
