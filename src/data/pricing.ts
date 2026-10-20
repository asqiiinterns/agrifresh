import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import type { Product } from "../types/product";
import { formatDay, formatPrice, formatQuantity } from "../ui/components";

// Prices and discounts set by each supplier (20261118_pro_modules_pricing.sql). The server computes every
// price; the app only shows the offers and asks the server for the live totals of the cart.

function client() {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  return supabase;
}
async function call<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await client().rpc(name, args);
  if (error) throw error;
  return data as T;
}

export type RuleKind = "percent" | "net_price" | "free_units" | "tiers";
export type Tier = { min_qty: number; percent: number };
export type PricingRule = {
  id?: string;
  name: string;
  kind: RuleKind;
  value?: number | null;
  buy_qty?: number | null;
  free_qty?: number | null;
  tiers: Tier[];
  target: "all" | "group" | "client";
  price_group_id?: string | null;
  client_id?: string | null;
  product_scope: "all" | "category" | "products";
  category_ids: string[];
  product_ids: string[];
  min_order_amount?: number | null;
  min_line_qty?: number | null;
  starts_on?: string | null;
  ends_on?: string | null;
  weekdays: number[];
  first_order_only: boolean;
  min_past_orders?: number | null;
  stackable: boolean;
  active: boolean;
};
// What a buyer sees of an offer (no targeting details).
export type Offer = Omit<PricingRule, "target" | "price_group_id" | "client_id" | "active" | "starts_on"> & { id: string; client_id: string };

export type PriceGroup = { id: string; name: string; clients: number };
export type PricingClient = { id: string; business_name: string; price_group_id: string | null };
export type PricingOverview = { groups: PriceGroup[]; clients: PricingClient[]; rules: (PricingRule & { id: string })[] };

export const fetchPricing = () => call<PricingOverview>("pricing_overview");
export const savePriceGroup = (id: string | null, name: string) => call<string>("pricing_save_group", { p_id: id, p_name: name });
export const deletePriceGroup = (id: string) => call<void>("pricing_delete_group", { p_id: id });
export const setClientPriceGroup = (clientId: string, groupId: string | null) => call<void>("pricing_set_client_group", { p_client_id: clientId, p_group_id: groupId });
export const saveRule = (rule: PricingRule) => call<string>("pricing_save_rule", { p_rule: rule });
export const setRuleActive = (id: string, active: boolean) => call<void>("pricing_set_rule_active", { p_id: id, p_active: active });
export const deleteRule = (id: string) => call<void>("pricing_delete_rule", { p_id: id });

export const emptyRule = (): PricingRule => ({
  name: "", kind: "percent", value: null, buy_qty: null, free_qty: null, tiers: [], target: "all", price_group_id: null, client_id: null,
  product_scope: "all", category_ids: [], product_ids: [], min_order_amount: null, min_line_qty: null, starts_on: null, ends_on: null,
  weekdays: [], first_order_only: false, min_past_orders: null, stackable: false, active: true,
});

export const kindLabels: Record<RuleKind, string> = {
  percent: "Pourcentage",
  net_price: "Prix net négocié",
  free_units: "X achetés + Y offerts",
  tiers: "Paliers de quantité",
};
export const weekdayLabels = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

// What a rule gives, in a few words ("−10 %", "5 + 1 offert", "dès 10 : −5 %").
export function ruleBenefit(rule: Pick<PricingRule, "kind" | "value" | "buy_qty" | "free_qty" | "tiers">): string {
  switch (rule.kind) {
    case "percent": return `−${formatQuantity(rule.value ?? 0)} %`;
    case "net_price": return `Prix net ${formatPrice(rule.value ?? 0)} HT`;
    case "free_units": return `${formatQuantity(rule.buy_qty ?? 0)} + ${formatQuantity(rule.free_qty ?? 0)} offert`;
    case "tiers": return rule.tiers.map((tier) => `dès ${formatQuantity(tier.min_qty)} : −${formatQuantity(tier.percent)} %`).join(" · ");
  }
}

// The conditions of a rule, in a few words.
export function ruleConditions(rule: Pick<PricingRule, "min_order_amount" | "min_line_qty" | "ends_on" | "weekdays" | "first_order_only" | "min_past_orders">): string[] {
  const parts: string[] = [];
  if (rule.min_order_amount) parts.push(`commande dès ${formatPrice(rule.min_order_amount)} HT`);
  if (rule.min_line_qty) parts.push(`dès ${formatQuantity(rule.min_line_qty)} par produit`);
  if (rule.weekdays?.length && rule.weekdays.length < 7) parts.push([...rule.weekdays].sort().map((day) => weekdayLabels[day - 1]).join(", "));
  if (rule.first_order_only) parts.push("1re commande");
  if (rule.min_past_orders) parts.push(`après ${rule.min_past_orders} commandes`);
  if (rule.ends_on) parts.push(`jusqu’au ${formatDay(rule.ends_on, { day: "numeric", month: "short" })}`);
  return parts;
}

// The offers of a supplier that cover a product.
export function offersFor(product: Product, offers: Offer[]): Offer[] {
  return offers.filter((offer) => offer.client_id === product.supplierId && (offer.product_scope === "all"
    || (offer.product_scope === "products" && offer.product_ids.includes(product.id))
    || (offer.product_scope === "category" && ((product.categoryId && offer.category_ids.includes(product.categoryId))
      || (product.categoryParentId && offer.category_ids.includes(product.categoryParentId))))));
}

// Live prices from the server.
export type PricedLine = { list_price: number; unit_price: number; line_total: number; discount: number; label: string | null; quantity: number };
export type CartPricing = {
  client_id?: string;
  lines: Record<string, PricedLine>;
  subtotal_list: number;
  subtotal: number;
  discount: number;
  applied: string[];
  next: { id: string; name: string; missing: number }[];
  hidden?: boolean;
};
export type CartGroup = { client_id: string; items: { product_id: string; quantity: number }[] };

// Before the migration (or without network) the screens keep catalogue prices: errors give null.
async function priceGroups(groups: CartGroup[], staffClientId?: string): Promise<Record<string, CartPricing> | null> {
  if (!supabase || !groups.length) return null;
  if (staffClientId) {
    const { data, error } = await supabase.rpc("staff_price_order", { p_client_id: staffClientId, p_items: groups[0]?.items ?? [] });
    return error || !data ? null : { [staffClientId]: data as CartPricing };
  }
  const { data, error } = await supabase.rpc("buyer_price_cart", { p_orders: groups });
  if (error || !Array.isArray(data)) return null;
  return Object.fromEntries((data as CartPricing[]).map((entry) => [entry.client_id ?? "", entry]));
}

// Prices of the cart, asked again 400 ms after the last change.
export function useCartPricing(groups: CartGroup[], staffClientId?: string) {
  const [pricing, setPricing] = useState<Record<string, CartPricing> | null>(null);
  const key = JSON.stringify(groups);
  const request = useRef(0);
  useEffect(() => {
    const id = ++request.current;
    if (!groups.length) { setPricing(null); return; }
    const timer = setTimeout(() => {
      void priceGroups(groups, staffClientId).then((next) => { if (id === request.current) setPricing(next); }).catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [key, staffClientId]);
  return pricing;
}
