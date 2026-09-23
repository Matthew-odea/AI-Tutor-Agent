import { useEffect, useRef, useState } from 'react';

interface ProctorCameraProps {
  stream: MediaStream | null;
  isRecording: boolean;
}

export default function ProctorCamera({ stream, isRecording }: ProctorCameraProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [minimised, setMinimised] = useState(false);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  if (!stream) return null;

  if (minimised) {
    return (
      <button
        onClick={() => setMinimised(false)}
        className="fixed bottom-4 right-4 z-40 w-10 h-10 rounded-full bg-gray-900 border-2 border-gray-700 shadow-overlay flex items-center justify-center hover:border-gray-500 transition-colors"
        title="Expand proctoring camera"
        aria-label="Expand proctoring camera"
      >
        {isRecording && (
          <span className="w-3 h-3 rounded-full bg-record animate-pulse" />
        )}
        {!isRecording && (
          <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.069A1 1 0 0121 8.82v6.36a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        )}
      </button>
    );
  }

  return (
    <div
      className="fixed bottom-4 right-4 z-40 shadow-overlay rounded-xl overflow-hidden border-2 border-gray-800 w-[120px] h-[90px] sm:w-[160px] sm:h-[120px]"
      title="Proctoring camera — your session is being recorded"
    >
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className="w-full h-full object-cover bg-black"
      />
      {isRecording && (
        <div className="absolute top-1.5 left-1.5 flex items-center space-x-1">
          <span className="w-2 h-2 rounded-full bg-record animate-pulse" />
          <span className="text-white text-[10px] font-bold leading-none bg-black/60 px-1 py-0.5 rounded">
            REC
          </span>
        </div>
      )}
      <button
        onClick={() => setMinimised(true)}
        className="absolute top-1 right-1 w-5 h-5 bg-black/60 hover:bg-black/80 rounded text-white text-xs flex items-center justify-center transition-colors"
        title="Minimise camera"
        aria-label="Minimise proctoring camera"
      >
        ×
      </button>
    </div>
  );
}
