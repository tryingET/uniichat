// Strict synthetic-testable stream conversion, with no service/config imports.
// Agent.events removes [DONE]; Chat Completions must terminate at finish_reason.
import type { Emit, Entry, Step, Use } from "./Agent.ts";
import type { Ask } from "./AskAI.ts";
import type { SubscriptionApi } from "./SubscriptionModels.ts";
import { object, text, type Obj } from "./SubscriptionRequest.ts";

const CONTEXT = "Subscription context window exceeded";
type Call = { id: string; name: string; arguments: string };
export type State = {
  api: SubscriptionApi; allowed: Set<string>; done: boolean; error: string;
  finish: string; blocks: Map<number, Obj>; open: Set<number>; json: Map<number, string>;
  calls: Map<number, Call>; message: Obj; output: unknown[] | null;
  responseCalls: Set<string>; usage: Obj | null;
};
export function start(api: SubscriptionApi, allowed: Set<string>): State {
  return { api, allowed, done: false, error: "", finish: "", blocks: new Map(), open: new Set(), json: new Map(), calls: new Map(), message: { role: "assistant", content: "" }, output: null, responseCalls: new Set(), usage: null };
}
// the provider's own message, else the start of its body, without any bearer token it echoes
export function said(message: unknown, body: string): string {
  const text = typeof message === "string" && message !== "" ? message : body;
  return text.slice(0, 2000).replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}
class Failed extends Error {}
function failed(body: Obj): Error {
  const error = typeof body.error === "object" && body.error !== null ? body.error as Obj : body;
  const message = typeof body.error === "string" ? body.error : error.message;
  return typeof message === "string" && message.trim() ? new Failed("Subscription provider error: " + said(message, "")) : new Error("subscription response incomplete or failed");
}
function fail(why: string): Step {
  // Native memory treats `fail` as a compressible context failure and clips it.
  // Protocol/auth/service failures must instead wait/stop, never create a summary.
  return { out: [], uses: [], entries: [], stop: why === CONTEXT ? "fail" : "down", off: why !== CONTEXT, why, note: "" };
}
function index(x: unknown): number {
  if (typeof x !== "number" || !Number.isSafeInteger(x) || x < 0 || x > 1024) throw new Error("invalid subscription stream index");
  return x;
}
function ordered<T>(map: Map<number, T>): T[] {
  return [...map.entries()].sort(([a], [b]) => a - b).map(([k, value], i) => {
    if (k !== i) throw new Error("incomplete subscription output indices");
    return value;
  });
}
function append(o: Obj, key: string, value: unknown): string {
  const delta = text(value);
  o[key] = (o[key] === undefined ? "" : text(o[key])) + delta;
  return delta;
}
function responses(st: State, ev: Obj, on: Emit): void {
  switch (ev.type) {
    case "response.output_text.delta": on("unii", text(ev.delta)); break;
    case "response.reasoning_summary_text.delta": on("mind", text(ev.delta)); break;
    case "response.function_call_arguments.delta": on("tool", text(ev.delta)); break;
    case "response.output_item.added": {
      const item = object(ev.item);
      if (item.type === "function_call") {
        st.responseCalls.add(text(item.call_id));
        on("tool", text(item.name) + " ", true);
      }
      break;
    }
    case "response.output_item.done": {
      const item = object(ev.item);
      st.blocks.set(index(ev.output_index), item);
      break;
    }
    case "response.completed": {
      const res = object(ev.response);
      if (res.status !== "completed" || res.error) throw new Error("subscription response is not completed");
      if (res.output !== undefined && !Array.isArray(res.output)) throw new Error("invalid subscription response output");
      st.output = res.output === undefined ? ordered(st.blocks) : res.output as unknown[];
      st.usage = res.usage === undefined ? null : object(res.usage);
      st.finish = "completed";
      st.done = true;
      break;
    }
    case "response.incomplete": case "response.failed": case "error": {
      const body = ev.type === "error" ? ev : object(ev.response);
      const error = body.error === undefined ? body : object(body.error);
      if (typeof error.code === "string" && ["context_length_exceeded", "model_context_window_exceeded"].includes(error.code)) {
        st.error = CONTEXT;
        st.done = true;
        break;
      }
      throw failed(body);
    }
  }
}
function chat(st: State, ev: Obj, on: Emit): void {
  if (ev.error) throw failed(ev);
  if (ev.usage != null) st.usage = object(ev.usage);
  if (!Array.isArray(ev.choices)) throw new Error("invalid subscription completion choices");
  if (!ev.choices.length) return; // Usage-only chunk.
  if (ev.choices.length !== 1) throw new Error("multiple subscription completions are unsupported");
  const choice = object(ev.choices[0]);
  if (choice.index !== 0) throw new Error("invalid subscription completion choice");
  const d = choice.delta == null ? {} : object(choice.delta);
  if (d.refusal) throw new Error("subscription response refused");
  if (d.role != null && d.role !== "assistant") throw new Error("invalid subscription completion role");
  // Keep the provider's replay field, not a fabricated summary.
  for (const field of ["reasoning_content", "reasoning", "reasoning_text"]) {
    if (typeof d[field] === "string" && d[field]) {
      on("mind", append(st.message, field, d[field]));
      break;
    }
  }
  if (d.reasoning_details != null) {
    if (!Array.isArray(d.reasoning_details)) throw new Error("invalid encrypted subscription reasoning");
    const prev = (st.message.reasoning_details ?? []) as unknown[];
    for (const detail of d.reasoning_details) {
      const r = object(detail);
      if (!(r.type === "reasoning.encrypted" && typeof r.data === "string") && !(r.type === "reasoning.text" && typeof r.text === "string") && !(r.type === "reasoning.summary" && typeof r.summary === "string")) {
        throw new Error("unsupported encrypted subscription reasoning");
      }
      prev.push(r);
    }
    st.message.reasoning_details = prev;
  }
  if (d.content != null) on("unii", append(st.message, "content", d.content));
  if (d.function_call != null) throw new Error("legacy subscription function calls are unsupported");
  if (d.tool_calls != null) {
    if (!Array.isArray(d.tool_calls)) throw new Error("invalid subscription tool deltas");
    for (const delta of d.tool_calls) {
      const t = object(delta);
      const k = index(t.index);
      if (t.type != null && t.type !== "function") throw new Error("unsupported subscription tool call type");
      const c = st.calls.get(k) ?? { id: "", name: "", arguments: "" };
      if (t.id != null) {
        if (c.id && c.id !== t.id) throw new Error("conflicting subscription tool call id");
        c.id = text(t.id);
      }
      if (t.function != null) {
        const f = object(t.function);
        if (f.name != null) {
          if (c.name && c.name !== f.name) throw new Error("conflicting subscription tool name");
          if (!c.name) on("tool", text(f.name) + " ", true);
          c.name = text(f.name);
        }
        if (f.arguments != null) {
          const delta = text(f.arguments);
          c.arguments += delta;
          on("tool", delta);
        }
      }
      st.calls.set(k, c);
    }
  }
  if (choice.finish_reason != null) {
    st.finish = text(choice.finish_reason);
    st.done = true;
  }
}
function messages(st: State, ev: Obj, on: Emit): void {
  switch (ev.type) {
    case "message_start": {
      const m = object(ev.message);
      if (m.usage !== undefined) st.usage = object(m.usage);
      break;
    }
    case "content_block_start": {
      const k = index(ev.index);
      if (st.blocks.has(k)) throw new Error("duplicate subscription content block");
      const b = { ...object(ev.content_block) };
      if (!["text", "thinking", "redacted_thinking", "tool_use"].includes(String(b.type))) throw new Error("unsupported subscription content block");
      st.blocks.set(k, b);
      st.open.add(k);
      if (b.type === "tool_use") on("tool", text(b.name) + " ", true);
      if (b.type === "text" && b.text) on("unii", text(b.text));
      if (b.type === "thinking" && b.thinking) on("mind", text(b.thinking));
      break;
    }
    case "content_block_delta": {
      const k = index(ev.index);
      const b = st.blocks.get(k);
      if (!b || !st.open.has(k)) throw new Error("subscription delta outside an open block");
      const d = object(ev.delta);
      if (d.type === "text_delta" && b.type === "text") on("unii", append(b, "text", d.text));
      else if (d.type === "thinking_delta" && b.type === "thinking") on("mind", append(b, "thinking", d.thinking));
      else if (d.type === "signature_delta" && b.type === "thinking") append(b, "signature", d.signature);
      else if (d.type === "input_json_delta" && b.type === "tool_use") {
        const delta = text(d.partial_json);
        st.json.set(k, (st.json.get(k) ?? "") + delta);
        on("tool", delta);
      } else throw new Error("unsupported subscription content delta");
      break;
    }
    case "content_block_stop": {
      const k = index(ev.index);
      if (!st.open.delete(k)) throw new Error("subscription block stopped without start");
      const json = st.json.get(k), block = st.blocks.get(k);
      if (json !== undefined && block) block.input = JSON.parse(json) as unknown;
      break;
    }
    case "message_delta": {
      st.finish = text(object(ev.delta).stop_reason);
      if (ev.usage !== undefined) st.usage = { ...st.usage, ...object(ev.usage) };
      break;
    }
    case "message_stop": st.done = true; break;
    case "error": throw failed(ev);
  }
}
export function read(st: State, event: unknown, on: Emit): boolean {
  if (st.done && (st.api !== "openai-completions" || st.error)) return true;
  try {
    const ev = object(event);
    if (st.done) {
      if (ev.error || !Array.isArray(ev.choices) || ev.choices.length) throw new Error("content after subscription completion");
      if (ev.usage != null) st.usage = object(ev.usage);
      return true;
    }
    if (typeof ev.type !== "string" && st.api !== "openai-completions") throw new Error("invalid subscription event");
    if (st.api === "openai-responses") responses(st, ev, on);
    else if (st.api === "openai-completions") chat(st, ev, on);
    else messages(st, ev, on);
  } catch (error) {
    // Only a provider's own error message, bearer redacted; never opaque
    // reasoning, arguments or bodies of malformed events.
    st.error = error instanceof Failed ? error.message : "invalid, incomplete or unsupported subscription stream";
    st.done = true;
  }
  return st.done;
}
function use(st: State, ids: Set<string>, id: unknown, name: unknown, input: unknown): Use {
  const i = text(id), n = text(name);
  if (!i.trim() || !n.trim() || ids.has(i) || !st.allowed.has(n)) throw new Error("invalid subscription tool identity");
  const value = object(input); // Reject null, arrays, primitives, malformed JSON.
  ids.add(i);
  return { id: i, name: n, input: value };
}
function finish(st: State): Step {
  if (!st.done || st.error) return fail(st.error || "subscription stream did not finish");
  const uses: Use[] = [], entries: Entry[] = [], ids = new Set<string>();
  let out: unknown[];
  if (st.api === "openai-responses") {
    if (st.finish !== "completed" || !st.output) throw new Error("incomplete subscription response");
    out = st.output;
    for (const item of out) {
      const b = object(item);
      if (b.status !== undefined && b.status !== "completed") throw new Error("unfinished subscription output item");
      if (b.type === "function_call") {
        const input: unknown = JSON.parse(text(b.arguments));
        const u = use(st, ids, b.call_id, b.name, input);
        uses.push(u);
        entries.push({ kind: "tool", text: u.name + " " + text(b.arguments), of: u.id });
      } else if (b.type === "message") {
        if (b.role !== undefined && b.role !== "assistant") throw new Error("invalid subscription output role");
        if (!Array.isArray(b.content)) throw new Error("invalid subscription output content");
        let say = "";
        for (const c of b.content) {
          const part = object(c);
          if (part.type !== "output_text") throw new Error("unsupported or refused subscription output");
          say += text(part.text);
        }
        if (say.trim()) entries.push({ kind: "unii", text: say });
      } else if (b.type === "reasoning") {
        if (b.encrypted_content !== undefined) text(b.encrypted_content);
        if (b.summary !== undefined) {
          if (!Array.isArray(b.summary)) throw new Error("invalid subscription reasoning summary");
          const summary = b.summary.map((s) => text(object(s).text)).join("\n\n");
          if (summary.trim()) entries.push({ kind: "mind", text: summary });
        }
      } else throw new Error("unsupported subscription output item");
    }
    for (const id of st.responseCalls) if (!ids.has(id)) throw new Error("unfinished subscription tool call");
  } else if (st.api === "openai-completions") {
    if (!["stop", "tool_calls"].includes(st.finish) || (st.calls.size > 0) !== (st.finish === "tool_calls")) throw new Error("incomplete subscription completion");
    const calls = ordered(st.calls);
    for (const c of calls) {
      const u = use(st, ids, c.id, c.name, JSON.parse(c.arguments) as unknown);
      uses.push(u);
      entries.push({ kind: "tool", text: c.name + " " + c.arguments, of: c.id });
    }
    if (calls.length) st.message.tool_calls = calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } }));
    const say = text(st.message.content);
    if (say.trim()) entries.unshift({ kind: "unii", text: say });
    for (const f of ["reasoning_content", "reasoning", "reasoning_text"]) if (typeof st.message[f] === "string" && st.message[f]) entries.unshift({ kind: "mind", text: text(st.message[f]) });
    out = [st.message];
  } else {
    if (st.open.size || !["end_turn", "tool_use"].includes(st.finish)) throw new Error("unfinished subscription message");
    out = ordered(st.blocks);
    for (const item of out) {
      const b = object(item);
      if (b.type === "tool_use") {
        const u = use(st, ids, b.id, b.name, b.input);
        uses.push(u);
        entries.push({ kind: "tool", text: u.name + " " + JSON.stringify(u.input), of: u.id });
      } else if (b.type === "text" && text(b.text).trim()) entries.push({ kind: "unii", text: text(b.text) });
      else if (b.type === "thinking") {
        // Signed thinking replays unchanged. Complete unsigned thinking is
        // replayed as its exact text, following Pi's compatibility conversion.
        if (b.signature != null && typeof b.signature !== "string") throw new Error("invalid subscription thinking signature");
        if (text(b.thinking).trim()) entries.push({ kind: "mind", text: text(b.thinking) });
      } else if (b.type === "redacted_thinking") text(b.data);
    }
    if ((uses.length > 0) !== (st.finish === "tool_use")) throw new Error("inconsistent subscription tool stop");
  }
  if (!uses.length && !entries.some((e) => e.kind === "unii" && e.text.trim())) return fail("subscription returned no text or tool calls");
  return { out, uses, entries, stop: uses.length ? "tools" : "done", why: "", note: "" };
}
export function step(st: State, ask: Ask): Step {
  try {
    const result = finish(st);
    if ((result.stop === "done" || result.stop === "tools") && st.usage) {
      ask.spent?.(st.usage);
      const input = st.usage.input_tokens ?? st.usage.prompt_tokens;
      if (typeof input === "number" && Number.isFinite(input) && input >= 0) {
        const read = st.usage.cache_read_input_tokens, write = st.usage.cache_creation_input_tokens;
        ask.used?.(input + (typeof read === "number" ? read : 0) + (typeof write === "number" ? write : 0));
      }
    }
    return result;
  } catch {
    return fail("invalid, incomplete or unsupported subscription output");
  }
}
