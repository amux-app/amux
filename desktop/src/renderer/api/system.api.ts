import { IPC } from '../../shared/ipc-channels';
import type {
  AppInfoResult,
  EditorDescriptor,
  ListEditorsResponse,
  ProjectFileSearchRequest,
  ProjectFileSearchResult,
  ProjectTextSearchRequest,
  ProjectTextSearchResult,
  SupportBundlePreview,
  SupportBundleResult,
} from '../../shared/ipc-types';
import { sanitizeProjectFileSearchResults, sanitizeProjectTextSearchResults, warnDroppedItems, warnInvalidPayload } from '../lib/runtimeValidation';
import { invoke } from './ipc';

export function getAppInfo(): Promise<AppInfoResult> {
  return invoke<AppInfoResult>(IPC.SYSTEM_APP_INFO);
}

export function revealPath(path: string): Promise<void> {
  return invoke<void>(IPC.SYSTEM_REVEAL_PATH, { path });
}

export function openExternal(url: string): Promise<void> {
  return invoke<void>(IPC.SYSTEM_OPEN_EXTERNAL, { url });
}

export async function openInEditor(path: string, file?: string, line?: number, editorId?: string): Promise<void> {
  const result = await invoke<{ success?: boolean; error?: string }>(IPC.SYSTEM_OPEN_IN_EDITOR, { path, file, line, editorId });
  if (result?.error) {
    throw new Error(result.error);
  }
}

export async function listEditors(): Promise<EditorDescriptor[]> {
  const result = await invoke<ListEditorsResponse>(IPC.SYSTEM_LIST_EDITORS);
  return Array.isArray(result?.editors) ? result.editors : [];
}

export async function previewSupportBundle(includeTranscripts: boolean): Promise<SupportBundlePreview> {
  const result = await invoke<SupportBundlePreview & { error?: string }>(IPC.SYSTEM_PREVIEW_SUPPORT_BUNDLE, { includeTranscripts });
  if (result?.error) {
    throw new Error(result.error);
  }
  return result;
}

export async function exportSupportBundle(includeTranscripts: boolean): Promise<SupportBundleResult> {
  const result = await invoke<SupportBundleResult & { error?: string }>(IPC.SYSTEM_EXPORT_SUPPORT_BUNDLE, { includeTranscripts });
  if (result?.error) {
    throw new Error(result.error);
  }
  return result;
}

export function clipboardWrite(text: string): Promise<void> {
  return invoke<void>(IPC.SYSTEM_CLIPBOARD_WRITE, { text });
}

export function clipboardRead(): Promise<string> {
  return invoke<{ text: string }>(IPC.SYSTEM_CLIPBOARD_READ).then((r) => r.text);
}

export async function searchProjectFiles(query: string, rootPath?: string): Promise<ProjectFileSearchResult[]> {
  const payload = await invoke<unknown>(
    IPC.PROJECT_FILE_SEARCH,
    { query, rootPath } satisfies ProjectFileSearchRequest,
  );

  const results = sanitizeProjectFileSearchResults(payload);
  if (!results) {
    warnInvalidPayload('project-file-search', payload);
    return [];
  }

  if (Array.isArray(payload) && results.length !== payload.length) {
    warnDroppedItems('project-file-search', payload.length, results.length);
  }

  return results;
}

export async function searchProjectText(query: string, rootPath?: string): Promise<ProjectTextSearchResult[]> {
  const payload = await invoke<unknown>(
    IPC.PROJECT_TEXT_SEARCH,
    { query, rootPath } satisfies ProjectTextSearchRequest,
  );

  const results = sanitizeProjectTextSearchResults(payload);
  if (!results) {
    warnInvalidPayload('project-text-search', payload);
    return [];
  }

  if (Array.isArray(payload) && results.length !== payload.length) {
    warnDroppedItems('project-text-search', payload.length, results.length);
  }

  return results;
}
