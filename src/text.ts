// Wording rules shared by the template generator, the LLM prompt and the brand-style check.
//
// The English strings here are the deterministic template wording, and the reference wording the
// language model is shown. The model writes in the user's own language, so the checks don't
// compare against these strings; they check language-neutral things instead (see checks.ts).

import type { Channel } from "./types.ts";
import { ENGLISH_VOICE_OPT_OUT } from "./voice.ts";

// "Oak Ridge Apartments" -> "Oak Ridge". Only a trailing "Apartments" is dropped, so
// "The Apartments at Legacy" stays as is, and a name that is just "Apartments" is kept whole.
export function shortPropertyName(propertyName: string): string {
  const name = propertyName.trim();
  const short = name.replace(/\s+Apartments$/i, "").trim();
  return short.length > 0 ? short : name;
}

// ["a", "b"] -> "a<pairJoiner>b"; ["a", "b", "c"] -> "a, b, and c"
export function joinList(items: string[], pairJoiner: string): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]}${pairJoiner}${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

// "es-MX", "ES", "es_mx" -> "es". Messages are compared on the primary language only.
export function primaryLanguage(code: string): string {
  return code.trim().toLowerCase().split(/[-_]/)[0];
}

// ---------------------------------------------------------------------------
// Subject (email only)
// ---------------------------------------------------------------------------

// Amenities named in a prospect's subject line, or [] for none. Only prospects (task_id starting
// with "prospect") get them.
export function subjectAmenities(task_id: string, amenityInterest: string[] | undefined): string[] {
  return task_id.startsWith("prospect") ? (amenityInterest ?? []) : [];
}

// "Tour Oak Ridge—See the pool & fitness rooms you asked about", or just "Tour Oak Ridge".
export function englishSubject(propertyName: string, amenities: string[]): string {
  const base = `Tour ${shortPropertyName(propertyName)}`;
  return amenities.length > 0 ? `${base}—See the ${joinList(amenities, " & ")} rooms you asked about` : base;
}

// ---------------------------------------------------------------------------
// SMS reply options and opt-out
// ---------------------------------------------------------------------------

export const SMS_MAX_LENGTH = 320;

// ["Thu", "Fri"] -> "Reply 1 for Thu, 2 for Fri."
export function englishReplyLine(options: string[]): string {
  return `Reply ${options.map((o, i) => `${i + 1} for ${o}`).join(", ")}.`;
}

// The carrier-standard opt-out keyword. It stays "STOP" in every language.
export const OPT_OUT_KEYWORD = "STOP";

export const ENGLISH_OPT_OUT: Record<Channel, string> = {
  sms: "Reply STOP to opt out.",
  email: "To opt out of emails, click here or reply STOP.",
  voice: ENGLISH_VOICE_OPT_OUT,
};
