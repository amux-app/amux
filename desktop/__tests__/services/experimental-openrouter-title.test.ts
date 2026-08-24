import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requestExperimentalOpenRouterTitle } from '../../src/main/services/title/ExperimentalOpenRouterTitle.js';

function response(content: string, ok = true): Response {
  return {
    json: vi.fn().mockResolvedValue({ choices: [{ message: { content } }] }),
    ok,
  } as unknown as Response;
}

describe('requestExperimentalOpenRouterTitle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('sends one bounded privacy-restricted request to the explicit model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response('"Fix sidebar title privacy"'));
    vi.stubGlobal('fetch', fetchMock);

    const title = await requestExperimentalOpenRouterTitle({
      apiKey: 'secret-key',
      model: 'openai/explicit-model',
      sourceText: 'x'.repeat(900),
    });

    expect(title).toBe('Fix sidebar title privacy');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init.body)) as {
      max_tokens: number;
      messages: Array<{ content: string }>;
      model: string;
      provider: { data_collection: string; zdr: boolean };
      temperature: number;
    };
    expect(body).toMatchObject({
      max_tokens: 24,
      model: 'openai/explicit-model',
      provider: { data_collection: 'deny', zdr: true },
      temperature: 0.2,
    });
    expect(body.messages.at(-1)?.content.length).toBeLessThan(700);
  });

  it('returns null on HTTP and parse failures', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response('', false))
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockRejectedValue(new Error('bad json')) });
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestExperimentalOpenRouterTitle({ apiKey: 'key', model: 'model', sourceText: 'Fix auth' }))
      .resolves.toBeNull();
    await expect(requestExperimentalOpenRouterTitle({ apiKey: 'key', model: 'model', sourceText: 'Fix auth' }))
      .resolves.toBeNull();
  });

  it('rejects multiline model output before whitespace normalization', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response('Here is the title:\nFix auth')));

    await expect(requestExperimentalOpenRouterTitle({ apiKey: 'key', model: 'model', sourceText: 'Fix auth' }))
      .resolves.toBeNull();
  });

  it('aborts the single request after three seconds', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = requestExperimentalOpenRouterTitle({ apiKey: 'key', model: 'model', sourceText: 'Fix auth' });
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(pending).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    { apiKey: '', model: 'model', sourceText: 'Fix auth' },
    { apiKey: 'key', model: '', sourceText: 'Fix auth' },
    { apiKey: 'key', model: 'model', sourceText: '  ' },
  ])('does not request with incomplete input: %j', async (input) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestExperimentalOpenRouterTitle(input)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
