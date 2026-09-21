/**
 * Query understanding layer.
 *
 * A user types "cheap 5V 3A buck regulator with usb-c" — that sentence mixes a
 * semantic intent (voltage regulator, step-down) with HARD constraints (5V out,
 * >=3A, price-sensitive, usb-c interface) that pure embedding similarity treats
 * as loose bag-of-words. This module runs a small fast LLM (Llama 3.1 8B on
 * Workers AI) ONCE per search to split the query into:
 *   - `semantic`  : a clean phrase to embed for dense recall
 *   - `keywords`  : exact tokens that MUST appear (part numbers, topology words)
 *   - filters     : structured numeric/string constraints applied after retrieval
 *
 * It is defensive: the model is asked for strict JSON, but if it returns garbage
 * or times out we fall back to the raw query with no filters, so search never
 * breaks because the LLM hiccuped.
 */
import type { Env } from "./types";

export interface Understanding {
  semantic: string; // phrase to embed
  keywords: string[]; // tokens that should appear in title/mpn (soft-required)
  type: string | null; // canonical product type, e.g. "buck converter", "microcontroller"
  voltage: number | null; // volts, output/operating
  current: number | null; // amps, minimum
  price_max: number | null; // INR ceiling
  interface: string | null; // e.g. "usb-c", "i2c", "spi"
  wants_cheap: boolean; // sort bias toward lower price
  raw: string;
}

const SYSTEM = `You convert an electronics component shopping query into strict JSON for a search engine.
Extract ONLY what is explicitly stated. Do not invent values.
Return a single JSON object, no prose, with keys:
  semantic   : string  - a clean noun phrase describing the part, no price/adjective noise (e.g. "5V buck converter module")
  keywords   : string[]- exact must-have tokens like part numbers or topology words (e.g. ["LM2596","buck"]). lowercase. [] if none.
  type       : string|null - canonical product category (e.g. "buck converter","microcontroller","resistor","sensor")
  voltage    : number|null - volts if a specific voltage is stated, else null
  current    : number|null - amps (minimum) if stated, else null
  price_max  : number|null - INR price ceiling if a number is stated, else null
  interface  : string|null - bus/connector if stated (e.g. "usb-c","i2c","spi","uart"), else null
  wants_cheap: boolean  - true if the user signals price sensitivity ("cheap","budget","lowest")
Examples:
Q: "cheap 5V 3A buck regulator" -> {"semantic":"5V 3A buck converter step down regulator","keywords":["buck"],"type":"buck converter","voltage":5,"current":3,"price_max":null,"interface":null,"wants_cheap":true}
Q: "esp32 chip" -> {"semantic":"ESP32 microcontroller chip module","keywords":["esp32"],"type":"microcontroller","voltage":null,"current":null,"price_max":null,"interface":null,"wants_cheap":false}
Q: "i2c oled display under 300" -> {"semantic":"I2C OLED display module","keywords":["oled"],"type":"display","voltage":null,"current":null,"price_max":300,"interface":"i2c","wants_cheap":false}`;

function fallback(q: string): Understanding {
  return {
    semantic: q,
    keywords: [],
    type: null,
    voltage: null,
    current: null,
    price_max: null,
    interface: null,
    wants_cheap: /\b(cheap|cheapest|budget|lowest|affordable)\b/i.test(q),
    raw: q,
  };
}

function coerceNum(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function extractJson(text: string): any | null {
  // The model usually returns clean JSON, but may wrap it in ```json fences or prose.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function understandQuery(q: string, env: Env): Promise<Understanding> {
  const model = env.QUERY_MODEL || "@cf/meta/llama-3.1-8b-instruct-fast";
  try {
    const out = (await env.AI.run(model as keyof AiModels, {
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Q: ${JSON.stringify(q)}` },
      ],
      max_tokens: 220,
      temperature: 0,
    } as any)) as any;

    // Workers AI returns either a legacy { response: string } or an
    // OpenAI-style chat completion { choices: [{ message: { content } }] }.
    const text: string =
      out?.choices?.[0]?.message?.content ??
      (typeof out?.response === "string" ? out.response : "") ??
      "";
    const j = extractJson(text);
    if (!j || typeof j !== "object") return fallback(q);

    const kw = Array.isArray(j.keywords)
      ? j.keywords.map((k: unknown) => String(k).toLowerCase().trim()).filter(Boolean).slice(0, 8)
      : [];
    const semantic = typeof j.semantic === "string" && j.semantic.trim() ? j.semantic.trim() : q;

    return {
      semantic,
      keywords: kw,
      type: typeof j.type === "string" && j.type.trim() ? j.type.trim().toLowerCase() : null,
      voltage: coerceNum(j.voltage),
      current: coerceNum(j.current),
      price_max: coerceNum(j.price_max),
      interface:
        typeof j.interface === "string" && j.interface.trim() ? j.interface.trim().toLowerCase() : null,
      wants_cheap: Boolean(j.wants_cheap),
      raw: q,
    };
  } catch {
    return fallback(q);
  }
}
