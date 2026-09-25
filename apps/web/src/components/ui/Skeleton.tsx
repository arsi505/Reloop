import React from 'react';

export function Skeleton({
  className = '',
  height,
  width,
}: {
  className?: string;
  height?: string | number;
  width?: string | number;
}) {
  return (
    <div
      className={`animate-shimmer rounded bg-[linear-gradient(90deg,var(--color-paper)_25%,var(--color-line)_50%,var(--color-paper)_75%)] bg-[length:200%_100%] ${className}`}
      style={{
        height: height !== undefined ? height : undefined,
        width: width !== undefined ? width : undefined,
      }}
    />
  );
}

export function MetricCardSkeleton() {
  return (
    <div className="p-4 rounded-brand bg-reloop-surface border border-reloop-line shadow-subtle space-y-3">
      <div className="flex items-center justify-between">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-2 w-2 rounded-full" />
      </div>
      <Skeleton className="h-7 w-16" />
      <div className="pt-2 border-t border-reloop-line flex items-center justify-between">
        <Skeleton className="h-2.5 w-20" />
        <Skeleton className="h-2.5 w-10" />
      </div>
    </div>
  );
}

export function TableRowSkeleton({ columns = 7 }: { columns?: number }) {
  return (
    <tr className="animate-pulse">
      {Array.from({ length: columns }).map((_, i) => (
        <td key={i} className="py-3 px-4">
          <Skeleton className={`h-4 ${i === 0 ? 'w-36' : i === 1 ? 'w-16' : 'w-20'}`} />
        </td>
      ))}
    </tr>
  );
}
