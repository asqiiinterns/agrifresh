import { part1 } from "./translations/part1";
import { part2 } from "./translations/part2";
import { part3 } from "./translations/part3";
import { part4 } from "./translations/part4";
import { patterns } from "./translations/patterns";

// Interface languages. French is the source: every text shown through ui/Text (and alerts, placeholders)
// is looked up here and shown in English or Arabic. Texts with values ({0}, {1}…) are matched by pattern.
// scripts/extract-strings.cjs lists the app's texts to keep these tables complete.
export type Language = "fr" | "en" | "ar";
export const languages: { value: Language; label: string }[] = [
  { value: "fr", label: "Français" },
  { value: "en", label: "English" },
  { value: "ar", label: "العربية" },
];

type Target = Exclude<Language, "fr">;
const index = (language: Target) => language === "en" ? 1 : 2;
const exact: Record<Target, Map<string, string>> = { en: new Map(), ar: new Map() };
const lower: Record<Target, Map<string, string>> = { en: new Map(), ar: new Map() };
for (const entry of [...part1, ...part2, ...part3, ...part4]) {
  for (const language of ["en", "ar"] as Target[]) {
    exact[language].set(entry[0], entry[index(language)]);
    lower[language].set(entry[0].toLowerCase(), entry[index(language)]);
  }
}

const escape = (text: string) => text.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
const compiled = patterns.map((entry) => {
  const order: number[] = [];
  const source = escape(entry[0]).replace(/\\?\{(\d+)\\?\}|\{(\d+)\}/g, (_match, a, b) => { order.push(Number(a ?? b)); return "(.+?)"; });
  return { regex: new RegExp(`^${source}$`, "s"), order, en: entry[1], ar: entry[2] };
});

// Each text is translated once per language, then served from the cache (rendering stays fast).
const cache: Record<Target, Map<string, string>> = { en: new Map(), ar: new Map() };

function lookup(text: string, language: Target): string | undefined {
  const direct = exact[language].get(text) ?? lower[language].get(text.toLowerCase());
  if (direct !== undefined) {
    const upper = language === "en" && text === text.toUpperCase() && /[A-ZÀ-Ý]/.test(text);
    return upper ? direct.toUpperCase() : direct;
  }
  for (const pattern of compiled) {
    const match = pattern.regex.exec(text);
    if (!match) continue;
    const values: Record<number, string> = {};
    pattern.order.forEach((slot, position) => { const value = match[position + 1]; values[slot] = lookup(value, language) ?? value; });
    return pattern[language].replace(/\{(\d+)\}/g, (_m, slot) => values[Number(slot)] ?? "");
  }
  return undefined;
}

export function translate(text: string, language: Language): string {
  if (language === "fr" || !text) return text;
  const hit = cache[language].get(text);
  if (hit !== undefined) return hit;
  const trimmed = text.trim();
  const found = trimmed ? lookup(trimmed, language) : undefined;
  const result = found === undefined ? text : text.replace(trimmed, found);
  if (cache[language].size > 5000) cache[language].clear();
  cache[language].set(text, result);
  return result;
}

// Current language for code outside React components (alerts, confirmations).
let currentLanguage: Language = "fr";
export const setCurrentLanguage = (language: Language) => { currentLanguage = language; };
export const tr = (text: string) => translate(text, currentLanguage);
// Locale for dates and amounts on screen (documents keep the French format).
export const appLocale = () => currentLanguage === "en" ? "en-GB" : currentLanguage === "ar" ? "ar-TN" : "fr-TN";
