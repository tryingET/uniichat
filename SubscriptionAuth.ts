import type { SubscriptionVendor } from "./SubscriptionModels.ts";
import { SubscriptionModels } from "./SubscriptionModels.ts";
import { forget, load, locked, save, secret, type Credential } from "./SubscriptionAuthStore.ts";
import { Denied, Transient, type LoginOptions } from "./SubscriptionAuthHttp.ts";
import { initial, renew, usable } from "./SubscriptionAuthProtocols.ts";

function check(vendor: SubscriptionVendor): void {
  if (!SubscriptionModels.isVendor(vendor)) throw new Error("Unknown subscription vendor");
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Subscription auth cancelled");
}
export async function login(dir: string, vendor: SubscriptionVendor, options: LoginOptions = {}): Promise<void> {
  check(vendor);
  await locked(dir, vendor, async () => {
    cancelled(options.signal);
    forget(dir, vendor);
    const credential = await initial(vendor, options);
    usable(credential);
    save(dir, vendor, credential);
  }, options.signal);
}
async function keyFromStdin(vendor: SubscriptionVendor, signal?: AbortSignal): Promise<string> {
  cancelled(signal);
  const go = vendor === "opencode-go";
  const name = go ? "dedicated Go key" : "OpenRouter key";
  // Dedicated env ONLY; never OPENAI_API_KEY, OPENCODE_API_KEY, OPENROUTER_API_KEY, or shared stores.
  const env = process.env[go ? "UNII_OPENCODE_GO_KEY" : "UNII_OPENROUTER_KEY"];
  if (env !== undefined) return secret(env);
  const input = process.stdin;
  const raw = input.isTTY ? input.isRaw : false;
  if (input.isTTY) {
    console.error(go ? "Enter the dedicated OpenCode Go key (hidden; never a general API key):" : "Enter an OpenRouter key (hidden):");
    input.setRawMode(true);
  }
  try {
    return await new Promise<string>((resolve, reject) => {
      let text = "";
      const finish = (error?: Error) => {
        input.off("data", data); input.off("end", end); input.off("error", fail);
        signal?.removeEventListener("abort", abort);
        input.pause();
        if (error) reject(error);
        else { try { resolve(secret(text)); } catch { reject(new Error("Invalid " + name)); } }
      };
      const abort = () => finish(new Error(name + " entry cancelled"));
      const fail = () => finish(new Error("Cannot read " + name));
      const end = () => finish();
      const data = (chunk: Buffer) => {
        for (const byte of chunk) {
          if (byte === 3 || byte === 4) { finish(new Error(name + " entry cancelled")); return; }
          if (byte === 10 || byte === 13) { finish(); return; }
          if (byte === 8 || byte === 127) text = text.slice(0, -1);
          else if (byte >= 33 && byte <= 126) text += String.fromCharCode(byte);
          else { finish(new Error("Invalid " + name + " input")); return; }
          if (text.length > 16384) { finish(new Error(name + " too long")); return; }
        }
      };
      input.on("data", data); input.once("end", end); input.once("error", fail);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else if (input.readableEnded) end();
      else input.resume();
    });
  } finally {
    if (input.isTTY) { input.setRawMode(raw); console.error(""); }
  }
}
export namespace SubscriptionAuth {
  // Local provisioning snapshot, not a live entitlement or billing assertion.
  export function status(dir: string, vendor: SubscriptionVendor): { connected: boolean; endpoint?: string; models?: string[] } {
    check(vendor);
    try {
      const c = load(dir, vendor);
      if (!c || c.blocked) return { connected: false };
      usable(c, true);
      return { connected: true, endpoint: c.endpoint, ...(c.models && !c.pending ? { models: [...c.models] } : {}) };
    } catch { return { connected: false }; }
  }
  export async function session(dir: string, vendor: SubscriptionVendor, refused?: string, signal?: AbortSignal): Promise<Credential> {
    check(vendor);
    cancelled(signal);
    return locked(dir, vendor, async () => {
      cancelled(signal);
      const old = load(dir, vendor);
      if (!old || old.blocked) throw new Error("Subscription not connected; run login for " + vendor);
      if (old.pending && vendor === "xai-sub") throw new Error("Subscription refresh outcome uncertain; log in again (refresh will not be replayed)");
      if (!old.pending) usable(old);
      if (!old.pending && old.access !== refused && old.expires > Date.now() + 5 * 60_000) return old;
      if (vendor === "opencode-go" || vendor === "openrouter") throw new Denied();
      // Clear access/models before dispatch. Crash, timeout, invalid JSON or an
      // uncertain response leaves this durable marker; NEVER replay that refresh.
      // Nonrotating identity remints can safely retry this unavailable state.
      save(dir, vendor, { ...old, access: "", models: undefined, pending: true });
      try {
        const next = await renew(old);
        usable(next);
        save(dir, vendor, next);
        // A caller cancellation cannot lose a successfully rotated refresh token.
        cancelled(signal);
        return next;
      } catch (error) {
        if (error instanceof Denied) forget(dir, vendor);
        if (error instanceof Transient) save(dir, vendor, old);
        throw error;
      }
    }, signal);
  }
  export async function cli(dir: string, vendor: SubscriptionVendor, args: string[]): Promise<void> {
    check(vendor);
    if (args.length !== 1 || !["login", "logout", "status", "models"].includes(args[0])) {
      throw new Error("Use login, logout, status, or models; secrets must never be passed as arguments");
    }
    if (args[0] === "logout") {
      await locked(dir, vendor, () => { forget(dir, vendor);  return Promise.resolve(); });
      console.log(vendor + ": local credentials removed (provider session not revoked)");
    } else if (args[0] === "status" || args[0] === "models") {
      // Local snapshot only; Copilot models are the last enabled account roster.
      const connection = status(dir, vendor);
      console.log(JSON.stringify(args[0] === "models" ? { ...connection, catalog: SubscriptionModels.models(vendor).map((m) => m.id), catalog_scope: "public capabilities, not account entitlement" } : connection));
    } else {
      const controller = new AbortController();
      const abort = () => controller.abort();
      process.once("SIGINT", abort); process.once("SIGTERM", abort);
      try {
        await login(dir, vendor, {
          signal: controller.signal,
          key: vendor === "opencode-go" || vendor === "openrouter" ? await keyFromStdin(vendor, controller.signal) : undefined,
          show: (url, code) => console.log("Open " + url + " and enter " + code + " only if you started this login."),
        });
        console.log(vendor + ": locally connected; configuration unchanged");
      } finally { process.off("SIGINT", abort); process.off("SIGTERM", abort); }
    }
  }
}
