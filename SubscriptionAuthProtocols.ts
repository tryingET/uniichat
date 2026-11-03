import { COPILOT_IDENTITY, type SubscriptionVendor } from "./SubscriptionModels.ts";
import { secret, type Credential } from "./SubscriptionAuthStore.ts";
import { copilotBase, Denied, device, form, lifetime, request, success, type Body, type LoginOptions } from "./SubscriptionAuthHttp.ts";

const XAI_CLIENT = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const GITHUB_CLIENT = "Iv1.b507a08c87ecfe98";
function endpoint(vendor: SubscriptionVendor): string {
  if (vendor === "xai-sub") return "https://api.x.ai/v1";
  if (vendor === "opencode-go") return "https://opencode.ai/zen/go";
  if (vendor === "openrouter") return "https://openrouter.ai/api/v1";
  throw new Error("Copilot requires an account endpoint");
}
function scope(value: unknown): string {
  if (typeof value !== "string" || !["grok-cli:access", "api:access"].every(s => value.split(/\s+/).includes(s))) throw new Denied();
  return value;
}
function xaiCredential(body: Body, previous?: Credential): Credential {
  const now = Date.now();
  if (body.token_type !== undefined && (typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer")) throw new Denied();
  return {
    vendor: "xai-sub", access: secret(body.access_token),
    refresh: body.refresh_token === undefined && previous ? secret(previous.refresh) : secret(body.refresh_token),
    scope: scope(body.scope === undefined ? previous?.scope ?? XAI_SCOPE : body.scope),
    // Match Pi's positive lifetime handling, bounded only by JS Date range.
    expires: now + lifetime(body.expires_in, 3600, (8.64e15 - now) / 1000) * 1000,
    endpoint: endpoint("xai-sub"),
  };
}
function entitledModels(raw: Body, base: string): string[] {
  if (!Array.isArray(raw.data)) throw new Denied();
  const rows = raw.data.filter((v): v is Body => !!v && typeof v === "object" && !Array.isArray(v)).filter(row => typeof row.id === "string" &&
      ((row.capabilities as Body | undefined)?.supports as Body | undefined)?.tool_calls !== false);
  const state = (row: Body) => (row.policy as Body | undefined)?.state;
  // Match Pi: picker models not disabled, else (Individual only) the enabled-policy fallback.
  const picked = rows.filter(row => row.model_picker_enabled === true && state(row) !== "disabled");
  const ids = (picked.length > 0 || base !== "https://api.individual.githubcopilot.com" ? picked : rows.filter(row => state(row) === "enabled"))
      .map(row => row.id as string);
  if (!ids.length) throw new Denied();
  return [...new Set(ids)];
}
function copilotEndpoint(body: Body): string {
  const token = secret(body.token);
  const proxies = [...token.matchAll(/(?:^|;)proxy-ep=([^;]+)/g)];
  if (proxies.length > 1) throw new Error("Ambiguous Copilot inference endpoint");
  const proxy = proxies[0]?.[1];
  const tokenBase = proxy ? copilotBase("https://" + proxy.replace(/^proxy\./, "api.")) : undefined;
  const endpoints = body.endpoints;
  const api = endpoints && typeof endpoints === "object" ? (endpoints as Body).api : undefined;
  const explicitBase = api === undefined ? undefined : copilotBase(api);
  if (explicitBase && tokenBase && explicitBase !== tokenBase) throw new Error("Conflicting Copilot inference endpoints");
  const base = explicitBase ?? tokenBase;
  if (!base) throw new Error("Missing Copilot inference endpoint");
  return base;
}
async function copilotCredential(identity: string, signal?: AbortSignal): Promise<Credential> {
  const body = success(await request("https://api.github.com/copilot_internal/v2/token", {
    headers: { accept: "application/json", authorization: "Bearer " + secret(identity), ...COPILOT_IDENTITY },
  }, signal));
  const base = copilotEndpoint(body);
  const expires = body.expires_at;
  if (typeof expires !== "number" || !Number.isFinite(expires) || expires * 1000 <= Date.now() || expires * 1000 > Date.now() + 86400_000) {
    throw new Error("Invalid Copilot token expiry");
  }
  const access = secret(body.token);
  const raw = success(await request(base + "/models", {
    headers: { accept: "application/json", authorization: "Bearer " + access, ...COPILOT_IDENTITY, "X-GitHub-Api-Version": "2026-06-01" },
  }, signal));
  return { vendor: "copilot-sub", access, refresh: identity, expires: expires * 1000, endpoint: base, models: entitledModels(raw, base) };
}
export async function initial(vendor: SubscriptionVendor, options: LoginOptions): Promise<Credential> {
  options.signal?.throwIfAborted();
  if (vendor === "opencode-go" || vendor === "openrouter") return { vendor, access: secret(options.key), expires: Number.MAX_SAFE_INTEGER, endpoint: endpoint(vendor) };
  if (vendor === "xai-sub") return xaiCredential(await device(vendor, "https://auth.x.ai/oauth2/device/code", "https://auth.x.ai/oauth2/token",
    { client_id: XAI_CLIENT, scope: XAI_SCOPE, referrer: "uniichat" }, options));
  const body = await device(vendor, "https://github.com/login/device/code", "https://github.com/login/oauth/access_token", { client_id: GITHUB_CLIENT, scope: "read:user" }, options);
  return copilotCredential(secret(body.access_token), options.signal);
}
// No caller cancellation on rotating refresh: caller must await durable settlement.
export async function renew(old: Credential): Promise<Credential> {
  if (old.vendor === "xai-sub") return xaiCredential(success(await form("https://auth.x.ai/oauth2/token", {
    grant_type: "refresh_token", client_id: XAI_CLIENT, refresh_token: secret(old.refresh),
  })), old);
  if (old.vendor === "copilot-sub") return copilotCredential(secret(old.refresh));
  throw new Denied();
}
export function usable(c: Credential, allow_pending = false): void {
  if (c.pending && (!allow_pending || c.vendor !== "copilot-sub")) throw new Denied();
  if (!c.pending) secret(c.access);
  if (c.vendor === "copilot-sub") {
    copilotBase(c.endpoint);
    if (!c.pending && !c.models?.length) throw new Denied();
  } else if (c.endpoint !== endpoint(c.vendor)) throw new Denied();
  if (c.vendor === "xai-sub") scope(c.scope);
  if (c.vendor !== "opencode-go" && c.vendor !== "openrouter") secret(c.refresh);
}
