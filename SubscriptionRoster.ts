// Server-only: each vendor's model list as its provider reports it, kept beside the data.
import * as fs from "node:fs";
import * as path from "node:path";
import { COPILOT_IDENTITY, SubscriptionModels, type SubscriptionApi, type SubscriptionModel, type SubscriptionVendor } from "./SubscriptionModels.ts";
import { SUBSCRIPTION_VENDORS } from "./SubscriptionPicks.ts";
import { SubscriptionAuth } from "./SubscriptionAuth.ts";
import { request, success, type Body } from "./SubscriptionAuthHttp.ts";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const FRESH = 24 * 3600_000;
const RETRY = 15 * 60_000;
const tried: Partial<Record<SubscriptionVendor, number>> = {};
const asked = new Set<SubscriptionVendor>();
const seen: Partial<Record<SubscriptionVendor, string>> = {};

const rec = (x: unknown): Body => (x && typeof x === "object" && !Array.isArray(x) ? x as Body : {});
const rows = (body: Body): Body[] => {
  const list = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
  return list.map(rec).filter((r) => typeof r.id === "string");
};
const count = (x: unknown, or: number): number => (typeof x === "number" && Number.isSafeInteger(x) && x > 0 ? x : or);
const efforts = (x: unknown): string[] => EFFORTS.filter((e) => Array.isArray(x) && x.includes(e));
const images = (x: unknown): string[] => (Array.isArray(x) && x.some((m) => typeof m === "string" && m.startsWith("image")) ? ["text", "image"] : ["text"]);

function made(id: string, api: SubscriptionApi, baseUrl: string, window: number, output: number, input: string[], reasoning: boolean, levels: string[], compat?: Record<string, unknown>): SubscriptionModel {
  return {
    label: id, id, speeds: ["slow"], window, output: Math.min(output, window), api, baseUrl, reasoning, input,
    efforts: levels.length > 0 ? levels : ["medium"],
    ...(reasoning && levels.length === 0 ? { thinkingLevelMap: { medium: null } } : {}),
    ...(compat ? { compat } : {}),
  };
}

function xai(listed: Body, language: Body): SubscriptionModel[] {
  const windows = new Map(rows(listed).map((r) => [r.id as string, r.context_length]));
  return rows(language).filter((r) => !Array.isArray(r.output_modalities) || r.output_modalities.includes("text")).map((r) => {
    const id = r.id as string;
    const reasoning = !id.includes("non-reasoning");
    const tunable = reasoning && !id.includes("-reasoning") && !id.startsWith("grok-build");
    const window = count(windows.get(id), 131072);
    return made(id, "openai-responses", "https://api.x.ai/v1", window, window, images(r.input_modalities), reasoning, tunable ? ["low", "medium", "high"] : []);
  });
}

function go(listed: Body, base: (api: SubscriptionApi) => string): SubscriptionModel[] {
  return rows(listed).flatMap((r) => {
    const caps = rec(r.capabilities);
    const think = rec(caps.reasoning);
    const routes = rec(r.api);
    const api: SubscriptionApi | undefined = "messages" in routes ? "anthropic-messages" : "responses" in routes ? "openai-responses" : "chat-completions" in routes ? "openai-completions" : undefined;
    if (api === undefined || (r.type !== undefined && r.type !== "chat") || rec(caps.tools).supported === false) return [];
    const limit = rec(r.limit);
    const window = count(limit.context, 131072);
    const levels = efforts(think.effort);
    const compat = api === "openai-completions" ? { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" }
      : api === "openai-responses" ? { sessionAffinityFormat: "openai-nosession" }
      : levels.length > 0 ? { forceAdaptiveThinking: true } : undefined;
    return [made(r.id as string, api, base(api), window, count(limit.output, window), images(rec(r.modalities).input), think.supported === true, levels, compat)];
  });
}

function copilot(listed: Body, entitled: string[], base: string): SubscriptionModel[] {
  return rows(listed).flatMap((r) => {
    const caps = rec(r.capabilities);
    const supports = rec(caps.supports);
    const limits = rec(caps.limits);
    const routes = Array.isArray(r.supported_endpoints) ? r.supported_endpoints : [];
    if (!entitled.includes(r.id as string) || (caps.type !== undefined && caps.type !== "chat")) return [];
    const api: SubscriptionApi = routes.includes("/v1/messages") ? "anthropic-messages" : routes.includes("/responses") ? "openai-responses" : "openai-completions";
    const levels = efforts(supports.reasoning_effort);
    const adaptive = supports.adaptive_thinking === true;
    const compat = api === "openai-completions" ? { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: levels.length > 0 }
      : api === "anthropic-messages" && adaptive ? { forceAdaptiveThinking: true } : undefined;
    const window = count(limits.max_context_window_tokens, 128000);
    return [made(r.id as string, api, base, window, count(limits.max_output_tokens, 16384), supports.vision === true ? ["text", "image"] : ["text"], levels.length > 0 || adaptive, levels, compat)];
  });
}

// Only OpenRouter's free, tool-capable models: its paid ones are metered.
function openrouter(listed: Body, base: string): SubscriptionModel[] {
  const free = (p: Body) => ["prompt", "completion", "request"].every((k) => p[k] === undefined || p[k] === "0");
  const taken = new Set<string>();
  return rows(listed).flatMap((r) => {
    const id = r.id as string;
    const params = Array.isArray(r.supported_parameters) ? r.supported_parameters : [];
    if (!free(rec(r.pricing)) || !params.includes("tools")) return [];
    const short = id.replace(/:free$/, "").replace(/^openrouter\//, "openrouter-").replace(/^.*\//, "");
    const label = taken.has(short) ? id.replace(/:free$/, "") : short;
    taken.add(label);
    const reasoning = params.includes("reasoning");
    const window = count(r.context_length, 131072);
    const compat = { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" };
    const model = made(id, "openai-completions", base, window, count(rec(r.top_provider).max_completion_tokens, 32768), images(rec(r.architecture).input_modalities), reasoning, reasoning && params.includes("reasoning_effort") ? ["low", "medium", "high"] : [], compat);
    return [{ ...model, label }];
  });
}

function file(dir: string, vendor: SubscriptionVendor): string {
  return path.join(path.resolve(dir), "subscription-models", vendor + ".json");
}

async function fetched(dir: string, vendor: SubscriptionVendor): Promise<SubscriptionModel[]> {
  const session = await SubscriptionAuth.session(dir, vendor);
  const headers = { accept: "application/json", authorization: "Bearer " + session.access };
  const get = async (url: string, extra: Record<string, string> = {}) => success(await request(url, { headers: { ...headers, ...extra } }));
  const catalog = SubscriptionModels.catalog(vendor);
  const live = vendor === "xai-sub" ? xai(await get(session.endpoint + "/models"), await get(session.endpoint + "/language-models"))
    : vendor === "opencode-go" ? go(await get(session.endpoint + "/v1/models"), (api) => catalog.find((c) => c.api === api)?.baseUrl ?? session.endpoint)
    : vendor === "openrouter" ? openrouter(await get(session.endpoint + "/models"), session.endpoint)
    : copilot(await get(session.endpoint + "/models", { ...COPILOT_IDENTITY, "X-GitHub-Api-Version": "2026-06-01" }), session.models ?? [], catalog[0]?.baseUrl ?? session.endpoint);
  return live.map((m) => catalog.find((c) => c.id === m.id) ?? m);
}

export namespace SubscriptionRoster {
  export function read(dir: string, vendor: SubscriptionVendor): SubscriptionModel[] | undefined {
    try {
      const list: unknown = JSON.parse(fs.readFileSync(file(dir, vendor), "utf8"));
      return Array.isArray(list) && list.length > 0 ? list as SubscriptionModel[] : undefined;
    } catch {
      return undefined;
    }
  }

  async function refresh(dir: string, vendor: SubscriptionVendor): Promise<void> {
    const list = await fetched(dir, vendor);
    if (list.length === 0) throw new Error("no models");
    const to = file(dir, vendor);
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.writeFileSync(to + ".new", JSON.stringify(list, null, 1));
    fs.renameSync(to + ".new", to);
  }

  export function when(dir: string): Partial<Record<SubscriptionVendor, number>> {
    return Object.fromEntries(SUBSCRIPTION_VENDORS.flatMap((v) => {
      try { return [[v, fs.statSync(file(dir, v)).mtimeMs]]; } catch { return []; }
    }));
  }

  // Refreshes a connected vendor's list when it is stale, the sign-in changed, or now; resolves to each refreshed vendor's success.
  export async function tend(dir: string, now = false): Promise<Partial<Record<SubscriptionVendor, boolean>>> {
    const due = SUBSCRIPTION_VENDORS.filter((v) => {
      const status = SubscriptionAuth.status(dir, v);
      const sign = JSON.stringify(status);
      if (!status.connected || asked.has(v)) return false;
      if (now) return true;
      let age = Infinity;
      try { age = Date.now() - fs.statSync(file(dir, v)).mtimeMs; } catch { /* none yet */ }
      const changed = seen[v] !== undefined && seen[v] !== sign;
      seen[v] = sign;
      return changed || (age > FRESH && Date.now() - (tried[v] ?? 0) > RETRY);
    });
    const done = await Promise.all(due.map(async (v) => {
      asked.add(v);
      tried[v] = Date.now();
      try {
        await refresh(dir, v);
        return true;
      } catch (err) {
        console.error("unii: " + v + " model list: " + (err instanceof Error ? err.message : String(err)));
        return false;
      } finally {
        asked.delete(v);
      }
    }));
    return Object.fromEntries(due.map((v, i) => [v, done[i]]));
  }
}
