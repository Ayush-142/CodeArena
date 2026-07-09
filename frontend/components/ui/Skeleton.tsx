export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-line/30 motion-reduce:animate-none ${className}`} />;
}
