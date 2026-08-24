import type {
  FileEol,
  FileWriteRequest,
  FileWriteResponse,
  TextChange,
} from '../../../shared/ipc-types';

export type EditorSessionStatus = 'clean' | 'dirty' | 'saving' | 'conflicted';

interface EditorSessionOptions {
  autosaveDelayMs?: number;
  applyChanges?: (changes: readonly TextChange[]) => void;
  contentVersion: string;
  eol: FileEol;
  fileKey: string;
  hasBom: boolean;
  id?: string;
  relativePath: string;
  rootPath: string;
  snapshot: () => string;
  write: (request: FileWriteRequest) => Promise<FileWriteResponse>;
  onConflict?: (response: Extract<FileWriteResponse, { success: false }>) => void;
  onError?: (error: unknown) => void;
  onSaved?: (content: string, response: Extract<FileWriteResponse, { success: true }>) => void;
  onStatusChange?: (status: EditorSessionStatus) => void;
}

interface FlushOptions {
  expectedMissing?: boolean;
}

const DEFAULT_AUTOSAVE_DELAY_MS = 800;

function createSessionId(): string {
  return globalThis.crypto.randomUUID();
}

export class EditorSession {
  readonly editorSessionId: string;
  readonly fileKey: string;
  readonly eol: FileEol;
  readonly hasBom: boolean;
  readonly relativePath: string;
  readonly rootPath: string;

  documentVersion = 0;
  persistedVersion = 0;
  contentVersion: string;

  private readonly autosaveDelayMs: number;
  private readonly applyDocumentChanges?: EditorSessionOptions['applyChanges'];
  private readonly onConflict?: EditorSessionOptions['onConflict'];
  private readonly onError?: EditorSessionOptions['onError'];
  private readonly onSaved?: EditorSessionOptions['onSaved'];
  private readonly onStatusChange?: EditorSessionOptions['onStatusChange'];
  private readonly snapshotDocument: () => string;
  private readonly write: EditorSessionOptions['write'];
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private saveQueue: Promise<boolean> = Promise.resolve(true);
  private saveSequence = 0;
  private status: EditorSessionStatus = 'clean';

  constructor(options: EditorSessionOptions) {
    this.autosaveDelayMs = options.autosaveDelayMs ?? DEFAULT_AUTOSAVE_DELAY_MS;
    this.applyDocumentChanges = options.applyChanges;
    this.contentVersion = options.contentVersion;
    this.editorSessionId = options.id ?? createSessionId();
    this.eol = options.eol;
    this.fileKey = options.fileKey;
    this.hasBom = options.hasBom;
    this.onConflict = options.onConflict;
    this.onError = options.onError;
    this.onSaved = options.onSaved;
    this.onStatusChange = options.onStatusChange;
    this.relativePath = options.relativePath;
    this.rootPath = options.rootPath;
    this.snapshotDocument = options.snapshot;
    this.write = options.write;
  }

  get isDirty(): boolean {
    return this.documentVersion !== this.persistedVersion;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  documentChanged(): void {
    if (this.disposed) return;
    this.documentVersion += 1;
    this.setStatus('dirty');
    this.scheduleAutosave();
  }

  adoptPersistedContentVersion(contentVersion: string): void {
    if (this.disposed) return;
    this.contentVersion = contentVersion;
    this.persistedVersion = this.documentVersion;
    this.setStatus('clean');
  }

  markConflicted(): void {
    if (this.disposed) return;
    this.cancelAutosave();
    this.setStatus('conflicted');
  }

  snapshot(): string {
    return this.snapshotDocument();
  }

  applyChanges(changes: readonly TextChange[]): boolean {
    if (this.disposed || !this.applyDocumentChanges || changes.length === 0) return false;
    this.applyDocumentChanges(changes);
    return true;
  }

  flush(options: FlushOptions = {}): Promise<boolean> {
    this.cancelAutosave();
    if (this.disposed) return Promise.resolve(false);
    if (!options.expectedMissing && !this.isDirty) return this.waitForPendingSaves();
    return this.enqueueSnapshot(options.expectedMissing === true);
  }

  async waitForPendingSaves(): Promise<boolean> {
    while (true) {
      const pending = this.saveQueue;
      const result = await pending;
      if (pending === this.saveQueue) return result;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAutosave();
  }

  private scheduleAutosave(): void {
    this.cancelAutosave();
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = null;
      void this.enqueueSnapshot(false);
    }, this.autosaveDelayMs);
  }

  private cancelAutosave(): void {
    if (this.autosaveTimer !== null) {
      clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
    }
  }

  private enqueueSnapshot(expectedMissing: boolean): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    const content = this.snapshotDocument();
    const documentVersion = this.documentVersion;
    const saveSequence = ++this.saveSequence;
    const save = () => this.persistSnapshot({
      content,
      documentVersion,
      expectedMissing,
      saveSequence,
    });
    const queued = this.saveQueue.then(save, save);
    this.saveQueue = queued;
    return queued;
  }

  private async persistSnapshot(snapshot: {
    content: string;
    documentVersion: number;
    expectedMissing: boolean;
    saveSequence: number;
  }): Promise<boolean> {
    if (this.disposed) return false;
    this.setStatus('saving');
    const request: FileWriteRequest = snapshot.expectedMissing
      ? {
          content: snapshot.content,
          documentVersion: snapshot.documentVersion,
          editorSessionId: this.editorSessionId,
          eol: this.eol,
          expectedContentVersion: null,
          expectedMissing: true,
          hasBom: this.hasBom,
          relativePath: this.relativePath,
          rootPath: this.rootPath,
          saveSequence: snapshot.saveSequence,
        }
      : {
          content: snapshot.content,
          documentVersion: snapshot.documentVersion,
          editorSessionId: this.editorSessionId,
          eol: this.eol,
          expectedContentVersion: this.contentVersion,
          hasBom: this.hasBom,
          relativePath: this.relativePath,
          rootPath: this.rootPath,
          saveSequence: snapshot.saveSequence,
        };

    try {
      const response = await this.write(request);
      if (
        this.disposed
        || response.editorSessionId !== this.editorSessionId
        || response.saveSequence !== snapshot.saveSequence
        || response.documentVersion !== snapshot.documentVersion
      ) return false;

      if (!response.success) {
        if (response.conflict) {
          this.setStatus('conflicted');
          this.onConflict?.(response);
        } else {
          this.setStatus('dirty');
          this.onError?.(new Error(response.error));
        }
        return false;
      }

      this.contentVersion = response.contentVersion;
      this.persistedVersion = Math.max(this.persistedVersion, snapshot.documentVersion);
      this.onSaved?.(snapshot.content, response);
      this.setStatus(this.isDirty ? 'dirty' : 'clean');
      return true;
    } catch (error) {
      if (!this.disposed) {
        this.setStatus('dirty');
        this.onError?.(error);
      }
      return false;
    }
  }

  private setStatus(nextStatus: EditorSessionStatus): void {
    if (this.status === nextStatus) return;
    this.status = nextStatus;
    this.onStatusChange?.(nextStatus);
  }
}
