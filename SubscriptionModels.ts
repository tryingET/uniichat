// Public capability snapshots, not account entitlement or a billing guarantee.
// Sources and generation provenance are recorded in SubscriptionCatalog.json.
import catalog from "./SubscriptionCatalog.json";
import { SubscriptionPicks, type SubscriptionVendor } from "./SubscriptionPicks.ts";

export { SUBSCRIPTION_VENDORS, type SubscriptionVendor } from "./SubscriptionPicks.ts";
export type SubscriptionApi = "openai-responses" | "openai-completions" | "anthropic-messages";
export type SubscriptionModel = {
  label: string; id: string; speeds: string[]; window: number; output: number;
  api: SubscriptionApi; baseUrl: string; reasoning: boolean; input: string[];
  efforts: string[]; thinkingLevelMap?: Record<string, string | number | null>;
  compat?: Record<string, unknown>; headers?: Record<string, string>;
};

export namespace SubscriptionModels {
  export const isVendor = SubscriptionPicks.isVendor;
  export function models(vendor: SubscriptionVendor): SubscriptionModel[] {
    const wire: Record<string, unknown> = catalog.models[vendor];
    return SubscriptionPicks.models(vendor).map((m) => ({ ...m, ...(wire[m.label] as object) }) as SubscriptionModel);
  }
  export function model(vendor: SubscriptionVendor, label: string): SubscriptionModel | undefined {
    return models(vendor).find((m) => m.label === label);
  }
}
