// ci/llmcomp/run.ts, which writes /llmcomp/'s sample answers, against
// mocked provider APIs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  compare,
  MODELS,
  PRICES_URL,
  type Results,
} from '../../ci/llmcomp/run.ts';
import { SAMPLES } from '../../ci/llmcomp/samples.ts';

const PRICE = { input_cost_per_token: 1e-6, output_cost_per_token: 4e-6 };

afterEach(() => vi.unstubAllGlobals());

describe('the llmcomp runner', () => {
  it('asks no API and writes the samples with no runs without a key', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const results = await compare({});
    expect(fetch).not.toHaveBeenCalled();
    expect(results.date).toBeNull();
    expect(results.samples.map((s) => s.runs)).toEqual(SAMPLES.map(() => []));
  });

  it("runs only the providers with a key, pricing each answer at LiteLLM's prices", async () => {
    const asked: { url: string; body: { model: string } }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url === PRICES_URL) {
        return Response.json(
          Object.fromEntries(MODELS.map((m) => [m.id, PRICE])),
        );
      }
      const body = JSON.parse(String(init?.body));
      asked.push({ url, body });
      if (body.model === 'claude-opus-5-5') {
        return Response.json(
          { error: { message: 'overloaded' } },
          { status: 400 },
        );
      }
      return url.includes('anthropic')
        ? Response.json({
            model: `${body.model}-20261101`,
            content: [
              { type: 'thinking', thinking: '…' },
              { type: 'text', text: 'Hi' },
            ],
            usage: { input_tokens: 10, output_tokens: 20 },
          })
        : Response.json({
            model: body.model,
            choices: [{ message: { content: 'Hello' } }],
            usage: { prompt_tokens: 10, completion_tokens: 20 },
          });
    });
    const results = await compare({
      ANTHROPIC_API_KEY: 'a',
      GEMINI_API_KEY: 'g',
    });
    expect(new Set(asked.map((a) => new URL(a.url).host))).toEqual(
      new Set(['api.anthropic.com', 'generativelanguage.googleapis.com']),
    );
    expect(asked.map((a) => a.body.model)).toContain('gemini-3.8-flash');
    const runs = results.samples[0]!.runs;
    expect(runs.map((r) => r.model)).toEqual(
      MODELS.filter((m) => ['anthropic', 'gemini'].includes(m.provider)).map(
        (m) => m.id,
      ),
    );
    expect(runs[0]).toMatchObject({
      model: 'claude-haiku-5-5',
      served: 'claude-haiku-5-5-20261101',
      answer: 'Hi',
      input: 10,
      output: 20,
      cost: 10 * 1e-6 + 20 * 4e-6,
    });
    expect(runs.find((r) => r.model === 'claude-opus-5-5')).toEqual({
      model: 'claude-opus-5-5',
      error: 'overloaded',
    });
    expect(results.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("has written every sample to the page's results.json", () => {
    const results: Results = JSON.parse(
      readFileSync(
        join(import.meta.dirname, '../../website/public/llmcomp/results.json'),
        'utf8',
      ),
    );
    expect(results.samples.map(({ runs: _, ...s }) => s)).toEqual(SAMPLES);
  });
});
