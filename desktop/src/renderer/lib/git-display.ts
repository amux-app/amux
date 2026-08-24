export function fileStatusLabel(status: string): string {
  switch (status) {
    case 'added': return 'A';
    case 'deleted': return 'D';
    case 'modified': return 'M';
    case 'renamed': return 'R';
    case 'copied': return 'C';
    case 'untracked': return '?';
    default: return '·';
  }
}

export function fileStatusColor(status: string): string | undefined {
  switch (status) {
    case 'added': return 'var(--success)';
    case 'deleted': return 'var(--error)';
    case 'modified': return 'var(--accent)';
    case 'untracked': return 'var(--text-muted)';
    default: return undefined;
  }
}
