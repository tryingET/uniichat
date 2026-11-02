import { type SubscriptionVendor } from "./SubscriptionModels.ts";
import { secret, type Credential } from "./SubscriptionAuthStore.ts";
import { Denied, device, form, lifetime, success, type Body, type LoginOptions } from "./SubscriptionAuthHttp.ts";

const XAI_CLIENT = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
function endpoint(vendor: SubscriptionVendor): string {
  if (vendor === "xai-sub") return "https://api.x.ai/v1";
  if (vendor === "opencode-go") return "https://opencode.ai/zen/go";
  throw new Denied();
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
export async function initial(vendor: SubscriptionVendor, options: LoginOptions): Promise<Credential> {
  options.signal?.throwIfAborted();
  if (vendor === "opencode-go") return { vendor, access: secret(options.key), expires: Number.MAX_SAFE_INTEGER, endpoint: endpoint(vendor) };
  if (vendor === "xai-sub") return xaiCredential(await device(vendor, "https://auth.x.ai/oauth2/device/code", "https://auth.x.ai/oauth2/token",
    { client_id: XAI_CLIENT, scope: XAI_SCOPE, referrer: "uniichat" }, options));
  throw new Denied();
}
// No caller cancellation on rotating refresh: caller must await durable settlement.
export async function renew(old: Credential): Promise<Credential> {
  if (old.vendor === "xai-sub") return xaiCredential(success(await form("https://auth.x.ai/oauth2/token", {
    grant_type: "refresh_token", client_id: XAI_CLIENT, refresh_token: secret(old.refresh),
  })), old);
  throw new Denied();
}
export function usable(c: Credential): void {
  secret(c.access);
  if (c.endpoint !== endpoint(c.vendor)) throw new Denied();
  if (c.vendor === "xai-sub") scope(c.scope);
  if (c.vendor !== "opencode-go") secret(c.refresh);
}
