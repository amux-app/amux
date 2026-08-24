export interface EditorRuntimeSnapshot {
  fileContentReads: number;
  formatterProcessesStarted: number;
  liveFormatterProcesses: number;
  liveLspProcesses: number;
  lspProcessesStarted: number;
}

/** Process-local, content-free counters used by editor zero-demand and soak checks. */
export class EditorRuntimeMetrics {
  private static instance: EditorRuntimeMetrics;
  private fileContentReads = 0;
  private formatterProcessesStarted = 0;
  private liveFormatterProcesses = 0;
  private readonly liveLspRoots = new Set<string>();
  private lspProcessesStarted = 0;

  static getInstance(): EditorRuntimeMetrics {
    if (!EditorRuntimeMetrics.instance) EditorRuntimeMetrics.instance = new EditorRuntimeMetrics();
    return EditorRuntimeMetrics.instance;
  }

  recordFileContentRead(): void {
    this.fileContentReads += 1;
  }

  recordFormatterStarted(): void {
    this.formatterProcessesStarted += 1;
    this.liveFormatterProcesses += 1;
  }

  recordFormatterStopped(): void {
    this.liveFormatterProcesses = Math.max(0, this.liveFormatterProcesses - 1);
  }

  recordLspStarted(rootId: string): void {
    if (this.liveLspRoots.has(rootId)) return;
    this.liveLspRoots.add(rootId);
    this.lspProcessesStarted += 1;
  }

  recordLspStopped(rootId: string): void {
    this.liveLspRoots.delete(rootId);
  }

  getSnapshot(): EditorRuntimeSnapshot {
    return {
      fileContentReads: this.fileContentReads,
      formatterProcessesStarted: this.formatterProcessesStarted,
      liveFormatterProcesses: this.liveFormatterProcesses,
      liveLspProcesses: this.liveLspRoots.size,
      lspProcessesStarted: this.lspProcessesStarted,
    };
  }
}
