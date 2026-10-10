import { z } from 'zod';

const Env = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().url().optional(),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  STATIC_DIR: z.string().optional(),
  // Optional OpenAI-compatible endpoint used only to rephrase deterministic answers
  // (Ollama, LM Studio, vLLM, OpenRouter, Groq, ...). Unset = deterministic answers only.
  LLM_BASE_URL: z.string().url().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default('llama3.1'),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(500).max(120000).default(20000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info')
});

export type Env = z.infer<typeof Env>;

export function loadEnv(src: Record<string, string | undefined> = process.env): Env {
  const r = Env.safeParse(src);
  if (!r.success) {
    const msg = r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${msg}`);
  }
  return r.data;
}
