import { jsonrepair } from "jsonrepair";
import { CheckResultSchema, type CheckResult } from "./types.js";

/**
 * Pulls the first JSON object out of a model reply (models often wrap it in prose or ``` fences).
 * Invalid JSON goes through jsonrepair: quotes copied from PDF text carry raw tabs and newlines,
 * and some models add trailing commas or stop mid-object.
 */
export function parseCheckResult(text: string): CheckResult {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1) throw new Error(`No JSON object in reply: ${text.slice(0, 200)}`);
  const body = end > start ? text.slice(start, end + 1) : text.slice(start);
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    raw = JSON.parse(jsonrepair(body));
  }
  return CheckResultSchema.parse(raw);
}
