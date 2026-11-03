// Public capability snapshots, not account entitlement or a billing guarantee.
// Sources and generation provenance are recorded in SubscriptionCatalog.json.
import known from "./SubscriptionCatalog.json";
import { SubscriptionPicks, type SubscriptionVendor } from "./SubscriptionPicks.ts";
import { VERSION } from "./Update.ts";

export { SUBSCRIPTION_VENDORS, type SubscriptionVendor } from "./SubscriptionPicks.ts";
export type SubscriptionApi = "openai-responses" | "openai-completions" | "anthropic-messages";
export type SubscriptionModel = {
  label: string; id: string; speeds: string[]; window: number; output: number;
  api: SubscriptionApi; baseUrl: string; reasoning: boolean; input: string[];
  efforts: string[]; thinkingLevelMap?: Record<string, string | number | null>;
  compat?: Record<string, unknown>;
};

// Copilot refuses any Editor-Version but a known IDE's.
export const COPILOT_IDENTITY = { "User-Agent": "unii/" + VERSION, "Editor-Version": "vscode/1.107.0" };

export namespace SubscriptionModels {
  export const isVendor = SubscriptionPicks.isVendor;
  const live: Partial<Record<SubscriptionVendor, SubscriptionModel[]>> = {};
  export function catalog(vendor: SubscriptionVendor): SubscriptionModel[] {
    const wire: Record<string, unknown> = known.models[vendor];
    return SubscriptionPicks.models(vendor).map((m) => ({ ...m, ...(wire[m.label] as object) }) as SubscriptionModel);
  }
  export function learn(vendor: SubscriptionVendor, list: SubscriptionModel[] | undefined): void {
    live[vendor] = list;
  }
  export function models(vendor: SubscriptionVendor): SubscriptionModel[] {
    return live[vendor] ?? catalog(vendor);
  }
  export function model(vendor: SubscriptionVendor, label: string): SubscriptionModel | undefined {
    return models(vendor).find((m) => m.label === label);
  }
}
