export function Skeleton({ w = '100%', h = 14, r = 6, className }: { w?: number | string; h?: number | string; r?: number; className?: string }) {
  return <span className={`skeleton ${className ?? ''}`} style={{ width: w, height: h, borderRadius: r }} aria-hidden />;
}

export function PanelSkeleton() {
  return (
    <div className="panel-skeleton" aria-busy="true">
      <Skeleton h={36} r={8} />
      {Array.from({ length: 9 }, (_, i) => (
        <div className="sk-row" key={i}>
          <Skeleton w={10} h={10} r={5} />
          <div style={{ flex: 1, display: 'grid', gap: 6 }}>
            <Skeleton w={`${55 + ((i * 17) % 30)}%`} h={12} />
            <Skeleton h={6} r={3} />
          </div>
        </div>
      ))}
    </div>
  );
}
