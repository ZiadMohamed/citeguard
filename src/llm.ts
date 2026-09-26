import type { Usage } from "./types.js";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface Message {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolSpec[];
  toolChoice?: "auto" | "required" | { type: "function"; function: { name: string } };
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResponse {
  message: Message;
  usage: Usage;
  finishReason: string;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export async function chat(req: ChatRequest, attempts = 4): Promise<ChatResponse> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set (copy .env.example to .env)");

  const body = JSON.stringify({
    model: req.model,
    messages: req.messages,
    tools: req.tools,
    tool_choice: req.toolChoice,
    temperature: req.temperature ?? 0,
    max_tokens: req.maxTokens ?? 2000,
    usage: { include: true },
  });

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** attempt + Math.random() * 500);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        const text = await res.text();
        lastError = new Error(`OpenRouter ${res.status}: ${text.slice(0, 500)}`);
        if (RETRYABLE.has(res.status)) continue;
        throw lastError;
      }
      const json = (await res.json()) as any;
      if (json.error) {
        lastError = new Error(`OpenRouter error: ${JSON.stringify(json.error).slice(0, 500)}`);
        continue;
      }
      const choice = json.choices?.[0];
      if (!choice) {
        lastError = new Error(`OpenRouter returned no choices: ${JSON.stringify(json).slice(0, 500)}`);
        continue;
      }
      return {
        message: choice.message,
        finishReason: choice.finish_reason,
        usage: {
          promptTokens: json.usage?.prompt_tokens ?? 0,
          completionTokens: json.usage?.completion_tokens ?? 0,
          costUsd: json.usage?.cost ?? 0,
        },
      };
    } catch (err) {
      lastError = err;
      if (err instanceof Error && err.message.startsWith("OpenRouter 4")) throw err;
    }
  }
  throw lastError;
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

export const ZERO_USAGE: Usage = { promptTokens: 0, completionTokens: 0, costUsd: 0 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
