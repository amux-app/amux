interface GitPillProps {
  children: React.ReactNode;
  color?: string;
}

export function GitPill({ children, color }: GitPillProps) {
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono bg-[var(--surface-raised)] border border-[var(--border)]"
      style={{ color: color ?? 'var(--text-muted)' }}
    >
      {children}
    </span>
  );
}
