import { IPC } from '../../shared/ipc-channels';
import type { PaneTopics } from '../../shared/topic-types';
import { sanitizePaneTopicsList, warnDroppedItems, warnInvalidPayload } from '../lib/runtimeValidation';
import { invoke } from './ipc';

export async function listTopics(): Promise<PaneTopics[]> {
  const payload = await invoke<unknown>(IPC.TOPICS_LIST);
  const topicsPayload = extractTopicsPayload(payload);
  const topics = sanitizePaneTopicsList(topicsPayload);

  if (!topics) {
    warnInvalidPayload('topics-list', payload);
    return [];
  }

  if (Array.isArray(topicsPayload) && topics.length !== topicsPayload.length) {
    warnDroppedItems('topics-list', topicsPayload.length, topics.length);
  }

  return topics;
}

function extractTopicsPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  return (payload as { topics?: unknown }).topics;
}
