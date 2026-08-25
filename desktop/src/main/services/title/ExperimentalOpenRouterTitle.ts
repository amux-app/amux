import { normalizeAutomaticPaneTitle } from 'muxbase/core';

const OPENROUTER_CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 3_000;
const SOURCE_CODE_POINT_LIMIT = 500;

interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

export interface ExperimentalOpenRouterTitleRequest {
  apiKey: string;
  model: string;
  sourceText: string;
}

function takeSourceText(value: string): string {
  let bounded = '';
  let count = 0;
  for (const codePoint of value.trim()) {
    if (count === SOURCE_CODE_POINT_LIMIT) break;
    bounded += codePoint;
    count++;
  }
  return bounded;
}

/**
 * Isolated, best-effort title experiment. The caller owns the three-part opt-in
 * gate; this function still validates all inputs so direct use fails closed.
 */
export async function requestExperimentalOpenRouterTitle(
  request: ExperimentalOpenRouterTitleRequest,
): Promise<string | null> {
  const apiKey = request.apiKey.trim();
  const model = request.model.trim();
  const sourceText = takeSourceText(request.sourceText);
  if (!apiKey || !model || !sourceText) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();

  try {
    const response = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: 'Create one concise task label. Return only the title on one line, without quotes or explanation.',
          },
          { role: 'user', content: sourceText },
        ],
        max_tokens: 24,
        temperature: 0.2,
        provider: {
          zdr: true,
          data_collection: 'deny',
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;

    const data = await response.json() as OpenRouterResponse;
    const rawTitle = data.choices?.[0]?.message?.content;
    if (typeof rawTitle !== 'string' || /[\r\n]/u.test(rawTitle)) return null;
    return normalizeAutomaticPaneTitle(rawTitle);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
