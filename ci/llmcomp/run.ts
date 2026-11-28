// Sends each of /llmcomp/'s sample prompts (samples.ts) to each model below
// and writes the answers, tokens, cost and time to
// website/public/llmcomp/results.json, which the page loads.
// .github/workflows/llmcomp.yml runs it with the providers' keys. A
// provider without a key is left out, so with no key at all the file has the
// samples and no runs.
//
//   OPENAI_API_KEY=… ANTHROPIC_API_KEY=… node ci/llmcomp/run.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { SAMPLES } from './samples.ts';

type Provider = 'openai' | 'anthropic' | 'gemini' | 'deepseek';

// LiteLLM's names, which the page's price table uses too, cheapest to
// frontier per provider.
export const MODELS: { id: string; provider: Provider }[] = [
  { id: 'gpt-6-luna', provider: 'openai' },
  { id: 'gpt-6.1-terra', provider: 'openai' },
  { id: 'gpt-6.2-sol', provider: 'openai' },
  { id: 'gpt-6.2-astra', provider: 'openai' },
  { id: 'claude-haiku-5-5', provider: 'anthropic' },
  { id: 'claude-sonnet-5-5', provider: 'anthropic' },
  { id: 'claude-opus-5-5', provider: 'anthropic' },
  { id: 'claude-fable-5-2', provider: 'anthropic' },
  { id: 'gemini/gemini-3.5-flash-lite', provider: 'gemini' },
  { id: 'gemini/gemini-3.8-flash', provider: 'gemini' },
  { id: 'gemini/gemini-pro-latest', provider: 'gemini' },
  { id: 'deepseek-v4-flash', provider: 'deepseek' },
  { id: 'deepseek-v4-pro', provider: 'deepseek' },
];

// OpenAI's, Google's and DeepSeek's chat completions take the same request.
const COMPLETIONS: Record<Exclude<Provider, 'anthropic'>, string> = {
  openai: 'https://api.openai.com/v1/chat/completions',
  gemini:
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  deepseek: 'https://api.deepseek.com/chat/completions',
};
export const KEYS: Record<Provider, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};
export const PRICES_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

export type Run = { model: string } & (
  | {
      // The model the API says answered, such as an alias's current model.
      served: string;
      answer: string;
      input: number;
      output: number;
      cost: number;
      seconds: number;
    }
  | { error: string }
);
export type Results = {
  date: string | null;
  samples: { id: string; title: string; prompt: string; runs: Run[] }[];
};

const Price = z.object({
  input_cost_per_token: z.number(),
  output_cost_per_token: z.number(),
});
const Failure = z.object({ error: z.object({ message: z.string() }) });
const Message = z.object({
  model: z.string(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});
const Completion = z.object({
  model: z.string(),
  choices: z
    .array(z.object({ message: z.object({ content: z.string() }) }))
    .min(1),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }),
});

const ask = async (
  model: (typeof MODELS)[number],
  prompt: string,
  key: string,
) => {
  const name = model.id.replace(/^[a-z]+\//, '');
  const messages = [{ role: 'user', content: prompt }];
  const [url, headers, body] =
    model.provider === 'anthropic'
      ? [
          'https://api.anthropic.com/v1/messages',
          { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          { model: name, max_tokens: 8192, messages },
        ]
      : [
          COMPLETIONS[model.provider],
          { authorization: `Bearer ${key}` },
          { model: name, messages },
        ];
  const start = performance.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  const data: unknown = await res.json();
  if (!res.ok) {
    const failure = Failure.safeParse(data);
    throw Object.assign(
      new Error(failure.data?.error.message ?? `HTTP ${res.status}`),
      { status: res.status },
    );
  }
  const seconds = (performance.now() - start) / 1000;
  if (model.provider === 'anthropic') {
    const m = Message.parse(data);
    return {
      served: m.model,
      answer: m.content.map((b) => (b.type === 'text' ? b.text : '')).join(''),
      input: m.usage.input_tokens,
      output: m.usage.output_tokens,
      seconds,
    };
  }
  const c = Completion.parse(data);
  return {
    served: c.model,
    answer: c.choices[0]!.message.content,
    input: c.usage.prompt_tokens,
    output: c.usage.completion_tokens,
    seconds,
  };
};

// One more try after a rate limit or a server error.
const askTwice = async (...args: Parameters<typeof ask>) => {
  try {
    return await ask(...args);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 0;
    if (status !== 429 && status < 500) throw err;
    await new Promise((resolve) => setTimeout(resolve, 20_000));
    return ask(...args);
  }
};

export const compare = async (
  env: Record<string, string | undefined>,
): Promise<Results> => {
  const models = MODELS.filter((m) => env[KEYS[m.provider]]);
  const prices = z
    .record(z.string(), z.unknown())
    .parse(models.length ? await (await fetch(PRICES_URL)).json() : {});
  // Each model answers the samples one at a time, so a time is one
  // request's, not a queue's; the models run in parallel.
  const runs = await Promise.all(
    models.map(async (m) => {
      const out: Run[] = [];
      for (const s of SAMPLES) {
        try {
          const price = Price.parse(prices[m.id]);
          const r = await askTwice(m, s.prompt, env[KEYS[m.provider]]!);
          const cost =
            r.input * price.input_cost_per_token +
            r.output * price.output_cost_per_token;
          out.push({ model: m.id, ...r, cost });
        } catch (err) {
          out.push({ model: m.id, error: (err as Error).message });
        }
      }
      return out;
    }),
  );
  return {
    date: models.length ? new Date().toISOString().slice(0, 10) : null,
    samples: SAMPLES.map((s, i) => ({ ...s, runs: runs.map((r) => r[i]!) })),
  };
};

if (import.meta.main) {
  const file = join(
    import.meta.dirname,
    '../../website/public/llmcomp/results.json',
  );
  const results = await compare(process.env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
  const failed = results.samples.flatMap((s) =>
    s.runs.flatMap((r) =>
      'error' in r ? [`${r.model} on ${s.id}: ${r.error}`] : [],
    ),
  );
  for (const f of failed) console.log(`::warning::${f}`);
  if (!results.date) {
    console.log(
      `::notice::No provider key (${Object.values(KEYS).join(', ')}), so no runs.`,
    );
  }
}
