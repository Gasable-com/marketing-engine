import { findPhoneNumbersInText, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

/**
 * Contacts found by pattern in a page's text or a Maps listing, without
 * Claude. Each is a verbatim match, so it needs no quote check.
 */
export type FoundContacts = { phones: string[]; emails: string[]; whatsapp: string[]; crs: string[] };

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/;
const CR_WORD = /\bC\.?\s?R(?![a-z])\.?|commercial\s+regist(?:ration|er|ry)|السجل\s*التجاري|سجل\s*تجاري|س\s*\.\s*ت/i;
const CR_REACH = 40;

/** Arabic-Indic and Persian digits as ASCII, so every pattern sees one form. */
function asciiDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (d) => String(d.charCodeAt(0) & 0xf));
}

const POSTAL_WORD = /(?:\b(?:postal(?:\s+code)?|zip(?:\s+code)?|p\.?\s?o\.?\s?box)|ص\.?\s?ب|الرمز\s*البريدي|رمز\s*بريدي)(?:\s*(?:no\.?|رقم))?[\s:#.-]*$/i;
const POSTAL_REACH = 30;
/** A link target that can hold a phone number; every other one is a path, an id or a SKU. */
const PHONE_TARGET = /^(?:tel:|mailto:|(?:https?:\/\/)?(?:wa\.me|api\.whatsapp\.com)\/)/i;

/**
 * The text phone numbers are looked for in: link targets and URLs gone (but
 * tel: and WhatsApp), Saudi national-address codes (`12271-6435`) gone, and
 * every list separator a line break, since the finder runs one number into
 * the next across a comma.
 */
function phoneText(t: string): string {
  return t
    .replace(/\]\(([^()\s]{0,2000})\)/g, (whole, target: string) => (PHONE_TARGET.test(target) ? whole : '] '))
    .replace(/(?:https?:\/\/|www\.)[^\s<>"'()[\]]{0,2000}/gi, (url) => (PHONE_TARGET.test(url) ? url : ' '))
    .replace(/(?<!\d)\d{5}\s?[-–]\s?\d{4}(?![\d-])/g, ' ')
    .replace(/[,،;|]|\s\/\s|(?<=\d{9})\s?[-–]\s?(?=\+?\d{9})/g, '\n');
}

/**
 * A Saudi number printed in national form starts with its trunk 0; without
 * it, a 9-digit run is a SKU or an order number. International forms, the
 * unified 9200 numbers, toll-free 800 numbers and tel: links count as printed.
 */
function saPrefixed(raw: string, before: string): boolean {
  if (/tel:\s*$/i.test(before) || /^[+0(]/.test(raw)) return true;
  return /^(?:966|92|800)/.test(raw.replace(/\D/g, ''));
}

export function contactsIn(text: string, opts: { country: string }): FoundContacts {
  const t = asciiDigits(text);
  const country = opts.country.toUpperCase();

  const phones = new Set<string>();
  const scan = phoneText(t);
  for (const found of findPhoneNumbersInText(scan, { defaultCountry: country as CountryCode })) {
    if (!found.number.isValid()) continue;
    const before = scan.slice(Math.max(0, found.startsAt - POSTAL_REACH), found.startsAt);
    if (POSTAL_WORD.test(before)) continue;
    if (country === 'SA' && !saPrefixed(scan.slice(found.startsAt, found.endsAt), before)) continue;
    phones.add(found.number.number);
  }

  const emails = new Set<string>();
  // Bounded, and starting where a run of address characters starts, so no run is rescanned.
  const email = /(?<![a-z0-9._%+-])[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){0,8}\.[a-z]{2,24}/gi;
  for (const m of t.matchAll(email)) {
    const email = m[0].toLowerCase();
    if (!IMAGE.test(email)) emails.add(email);
  }

  const whatsapp = new Set<string>();
  const wa = /(?:wa\.me\/|api\.whatsapp\.com\/send\/?\?(?:[^\s"'<>]*?&)?phone=)\+?(\d{6,15})/gi;
  for (const m of t.matchAll(wa)) {
    const phone = parsePhoneNumberFromString(`+${m[1]}`);
    if (phone?.isValid()) whatsapp.add(phone.number);
  }

  const crs = new Set<string>();
  if (country === 'SA') {
    for (const m of t.matchAll(/(?<!\d)[1-57]\d{9}(?!\d)/g)) {
      const at = m.index ?? 0;
      const around = t.slice(Math.max(0, at - CR_REACH), at + m[0].length + CR_REACH);
      if (CR_WORD.test(around)) crs.add(m[0]);
    }
  }

  return { phones: [...phones], emails: [...emails], whatsapp: [...whatsapp], crs: [...crs] };
}
