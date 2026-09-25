import { CheckResultSchema, type CheckResult } from "./types.js";

/** Pulls the first JSON object out of a model reply (models often wrap it in prose or ``` fences). */
export function parseCheckResult(text: string): CheckResult {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error(`No JSON object in reply: ${text.slice(0, 200)}`);
  const raw = JSON.parse(text.slice(start, end + 1));
  return CheckResultSchema.parse(raw);
}
