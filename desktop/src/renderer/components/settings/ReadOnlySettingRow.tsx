interface ReadOnlySettingRowProps {
  label: string;
  description: string;
  value: string;
}

export function ReadOnlySettingRow({ label, description, value }: ReadOnlySettingRowProps) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-[var(--text)]">{label}</div>
        <div className="mt-0.5 text-xs text-[var(--text-muted)]">{description}</div>
      </div>
      <div className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 font-mono text-xs text-[var(--text-secondary)]">
        {value}
      </div>
    </div>
  );
}
