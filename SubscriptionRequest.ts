// Native request dialects. References: Pi api/openai-{responses,completions}.ts,
// api/anthropic-messages.ts; Cells nodecode-{xai-oauth,muse-code}/provider.lisp.
// No runtime imports of Agent/AskAI: those load user configuration and services.
import type { Ask, Img } from "./AskAI.ts";
import type { Item, Tool } from "./Agent.ts";
import { SubscriptionModels, SUBSCRIPTION_VENDORS, type SubscriptionModel, type SubscriptionVendor } from "./SubscriptionModels.ts";

export type Obj = Record<string, unknown>;
export class SubscriptionContextLimit extends Error {
  constructor() { super("Subscription context window has no output room"); }
}
export function object(x: unknown): Obj {
  if (x === null || typeof x !== "object" || Array.isArray(x)) throw new Error("invalid subscription protocol object");
  return x as Obj;
}
export function text(x: unknown): string {
  if (typeof x !== "string") throw new Error("invalid subscription protocol text");
  return x;
}
export function vendorOf(model: SubscriptionModel): SubscriptionVendor {
  for (const vendor of SUBSCRIPTION_VENDORS) {
    if (SubscriptionModels.models(vendor).some((m) => m.id === model.id && m.api === model.api && m.baseUrl === model.baseUrl)) return vendor;
  }
  throw new Error("unsupported subscription model/protocol/endpoint combination");
}

const COPILOT = ["api.githubcopilot.com", "api.individual.githubcopilot.com", "api.business.githubcopilot.com", "api.enterprise.githubcopilot.com"];
export function destination(model: SubscriptionModel, vendor: SubscriptionVendor, base: string): string {
  // Compare raw URLs, not just normalized hosts (reject userinfo, ports, query,
  // fragments, encoded paths and dot-segments before any credential can leave).
  const clean = base.replace(/\/$/, "");
  const allowed = vendor === "copilot-sub" ? COPILOT.map((h) => "https://" + h)
    : vendor === "opencode-go" ? ["https://opencode.ai/zen/go", "https://opencode.ai/zen/go/v1"]
    : vendor === "muse-sub" ? ["https://api.meta.ai/v1"]
    : ["https://api.x.ai/v1"];
  if (!allowed.includes(clean)) throw new Error("unsafe subscription inference endpoint");
  const root = vendor === "opencode-go" ? "https://opencode.ai/zen/go" + (model.api === "anthropic-messages" ? "" : "/v1") : clean;
  // Anthropic SDK resources/messages/messages.ts appends /v1/messages to
  // baseURL; unlike the OpenAI lanes, these catalog bases do not include /v1.
  return root + (model.api === "openai-responses" ? "/responses" : model.api === "openai-completions" ? "/chat/completions" : "/v1/messages");
}

function effort(model: SubscriptionModel, ask: Ask): string | number | undefined {
  if (!model.efforts.includes(ask.effort)) throw new Error("unsupported subscription reasoning effort");
  if (!model.reasoning) return undefined;
  const mapped = model.thinkingLevelMap?.[ask.effort];
  return mapped === null ? undefined : mapped ?? ask.effort;
}

function image(img: Img, api: SubscriptionModel["api"]): Obj {
  if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(img.type) || !/^[A-Za-z0-9+/]+={0,2}$/.test(img.data)) {
    throw new Error("unsupported subscription image encoding");
  }
  return api === "anthropic-messages" ? { type: "image", source: { type: "base64", media_type: img.type, data: img.data } }
    : api === "openai-responses" ? { type: "input_image", image_url: "data:" + img.type + ";base64," + img.data }
    : { type: "image_url", image_url: { url: "data:" + img.type + ";base64," + img.data } };
}
function content(texts: string[], imgs: Img[], api: SubscriptionModel["api"]): Obj[] {
  return [...texts.filter((t) => t !== "").map((t) => ({ type: api === "openai-responses" ? "input_text" : "text", text: t })), ...imgs.map((img) => image(img, api))];
}
export function hasImages(items: Item[]): boolean {
  return items.some((i) => i.$ === "User" ? i.imgs.length > 0 : i.$ === "Back" && i.backs.some((b) => (b.out.imgs?.length ?? 0) > 0));
}

function responsesInput(items: Item[]): unknown[] {
  return items.flatMap((i): unknown[] => {
    if (i.$ === "User") return [{ role: "user", content: content(i.parts.map((p) => p.text), i.imgs, "openai-responses") }];
    if (i.$ === "Turn") return i.out;
    return i.backs.map((b) => ({ type: "function_call_output", call_id: b.id, output: content([b.out.text], b.out.imgs ?? [], "openai-responses") }));
  });
}
function messagesInput(items: Item[]): Obj[] {
  const messages: Obj[] = [];
  const push = (role: string, blocks: unknown[]) => {
    const last = messages.at(-1);
    if (last?.role === role) (last.content as unknown[]).push(...blocks);
    else messages.push({ role, content: [...blocks] });
  };
  for (const i of items) {
    if (i.$ === "User") push("user", content(i.parts.map((p) => p.text), i.imgs, "anthropic-messages"));
    if (i.$ === "Turn") push("assistant", i.out.map((item) => {
      const b = object(item);
      // Pi anthropic-messages convertMessages: unsigned compatible-provider
      // thinking cannot replay as an Anthropic signed block. Preserve its exact
      // text, not a fabricated summary (only after a completed, checked turn).
      return b.type === "thinking" && !b.signature ? { type: "text", text: text(b.thinking) } : b;
    }));
    if (i.$ === "Back") push("user", i.backs.map((b) => ({ type: "tool_result", tool_use_id: b.id, is_error: b.out.fail, content: content([b.out.text], b.out.imgs ?? [], "anthropic-messages") })));
  }
  return messages;
}
function chatInput(model: SubscriptionModel, vendor: SubscriptionVendor, items: Item[]): Obj[] {
  const messages: Obj[] = [], images: Obj[] = [];
  for (const i of items) {
    if (i.$ !== "Back") messages.push(...images.splice(0));
    if (i.$ === "User") messages.push({ role: "user", content: content(i.parts.map((p) => p.text), i.imgs, "openai-completions") });
    if (i.$ === "Turn") messages.push(...i.out.map((o) => {
      const msg = { ...object(o) };
      if (msg.role !== "assistant") throw new Error("incompatible subscription history");
      if (model.compat?.requiresReasoningContentOnAssistantMessages && msg.reasoning_content === undefined) msg.reasoning_content = "";
      // Pi's Go bridge returns `reasoning` but expects reasoning_content on replay.
      if (vendor === "opencode-go" && typeof msg.reasoning === "string") {
        msg.reasoning_content = msg.reasoning;
        delete msg.reasoning;
      }
      return msg;
    }));
    if (i.$ === "Back") for (const b of i.backs) {
      messages.push({ role: "tool", tool_call_id: b.id, content: b.out.text });
      // Tool images must wait until all contiguous tool replies are delivered.
      if (b.out.imgs?.length) images.push({ role: "user", content: content(["Images from tool result " + b.id], b.out.imgs, "openai-completions") });
    }
  }
  return [...messages, ...images];
}

function grokSchema(schema: object): object {
  const s = object(schema);
  const key = Array.isArray(s.anyOf) ? "anyOf" : "oneOf";
  const branches = s[key];
  if ((s.type === "object" || s.properties || (Array.isArray(s.type) && s.type.includes("object"))) && Array.isArray(branches) && branches.length > 0 && branches.every((b: unknown) => {
    if (b === null || typeof b !== "object" || Array.isArray(b)) return false;
    const o = object(b);
    return Array.isArray(o.required) && o.required.length > 0 && o.required.every((k) => typeof k === "string" && k.length > 0) && Object.keys(o).every((k) => ["required", "title", "description"].includes(k));
  })) {
    const copy = { ...s };
    delete copy[key];
    return copy;
  }
  return schema;
}

export function request(model: SubscriptionModel, vendor: SubscriptionVendor, ask: Ask, items: Item[], tools: Tool[], max: number): Obj {
  if (ask.model !== model.id && ask.model !== model.label) throw new Error("subscription model does not match request");
  if (!model.speeds.includes(ask.speed)) throw new Error("unsupported subscription speed");
  if (ask.searches > 0) throw new Error("native subscription web search is unsupported");
  if (hasImages(items) && !model.input.includes("image")) throw new Error("subscription model does not accept images");
  const e = effort(model, ask);
  if (typeof e === "number") throw new Error("unsupported numeric subscription effort mapping");
  if (![max, model.output, model.window].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error("invalid subscription token budget");
  // Text uses a conservative UTF-8 byte count, not a tokenizer. Pi's
  // utils/estimate.ts reserves 4800/3.5 tokens per image, not base64 bytes.
  // This is a context estimate; the service remains authoritative.
  let images = 0;
  const estimateImage = (img: Img) => { images++; return { type: img.type }; };
  const history = JSON.stringify(items.map((i) => i.$ === "User" ? { ...i, imgs: i.imgs.map(estimateImage) }
    : i.$ === "Back" ? { ...i, backs: i.backs.map((b) => ({ ...b, out: { ...b.out, imgs: b.out.imgs?.map(estimateImage) } })) } : i));
  const inputEstimate = new TextEncoder().encode(ask.system + history + JSON.stringify(tools)).length + images * Math.ceil(4800 / 3.5);
  const cap = Math.min(max, model.output, model.window - inputEstimate);
  if (cap < 16) throw new SubscriptionContextLimit();
  const body: Obj = { model: model.id, stream: true };
  const grok = model.id.startsWith("grok-");
  if (model.api === "openai-responses") {
    Object.assign(body, { store: false, max_output_tokens: cap, input: [{ role: model.compat?.supportsDeveloperRole === false ? "system" : "developer", content: [{ type: "input_text", text: ask.system }] }, ...responsesInput(items)] });
    if (model.reasoning) {
      body.include = ["reasoning.encrypted_content"];
      if (e !== undefined && !model.id.startsWith("grok-build") && !model.id.includes("-reasoning")) body.reasoning = { effort: e };
    }
    if (tools.length) body.tools = tools.map((t) => ({ type: "function", name: t.name, description: t.info, parameters: grok ? grokSchema(t.schema) : t.schema }));
  } else if (model.api === "anthropic-messages") {
    Object.assign(body, { max_tokens: cap, system: [{ type: "text", text: ask.system }], messages: messagesInput(items) });
    if (model.reasoning) {
      if (model.compat?.forceAdaptiveThinking) {
        body.thinking = { type: "adaptive" };
        if (e !== undefined) body.output_config = { effort: e };
      } else {
        if (cap < 2048) throw new Error("subscription thinking requires at least 2048 output tokens");
        body.thinking = { type: "enabled", budget_tokens: Math.min(8192, cap - 1024) };
      }
    }
    if (tools.length) body.tools = tools.map((t) => ({ name: t.name, description: t.info, input_schema: t.schema }));
  } else {
    Object.assign(body, { stream_options: { include_usage: true }, [model.compat?.maxTokensField === "max_tokens" ? "max_tokens" : "max_completion_tokens"]: cap, messages: [{ role: model.compat?.supportsDeveloperRole === false ? "system" : "developer", content: ask.system }, ...chatInput(model, vendor, items)] });
    const format = model.compat?.thinkingFormat;
    if (format !== undefined && (typeof format !== "string" || !["deepseek", "qwen", "zai", "openai"].includes(format))) throw new Error("unsupported subscription thinking format");
    if (model.reasoning) {
      if (format === "deepseek") body.thinking = { type: "enabled" };
      if (format === "qwen") body.enable_thinking = true;
      if (format === "zai") body.thinking = { type: "enabled", clear_thinking: false };
      if (model.compat?.supportsReasoningEffort !== false && e !== undefined) body.reasoning_effort = e;
    }
    if (tools.length) body.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.info, parameters: t.schema } }));
  }
  return body;
}
