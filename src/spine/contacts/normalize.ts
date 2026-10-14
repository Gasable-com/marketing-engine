import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

export const CHANNELS = ['sms', 'whatsapp', 'email', 'telegram'] as const;
export type Channel = (typeof CHANNELS)[number];

export const PURPOSES = ['transactional', 'marketing', 'outreach'] as const;
export type Purpose = (typeof PURPOSES)[number];

/**
 * Whether a purpose is promotional: it carries an opt-out (the unsubscribe
 * text, List-Unsubscribe) and keeps to the promotional sending windows.
 * Marketing needs consent as well; outreach to a found buyer does not.
 */
export function isPromotional(purpose: Purpose): boolean {
  return purpose !== 'transactional';
}

export type NormalizedContact = {
  channel: Channel;
  /** E.164 for phones, lower-cased for email, as given for telegram. */
  address: string;
  /** ISO 3166-1 alpha-2, or null when the address does not imply one. */
  region: string | null;
};

export class InvalidAddressError extends Error {}

/**
 * Turn a raw address into the one form everything else stores and compares.
 * Pure: no database, no clock. `defaultCountry` lets a caller accept a national
 * number like 0501234567; without it such a number is rejected.
 */
export function normalize(input: {
  channel: Channel;
  address: string;
  defaultCountry?: string | undefined;
}): NormalizedContact {
  const raw = input.address.trim();
  if (!raw) throw new InvalidAddressError('address is empty');

  switch (input.channel) {
    case 'sms':
    case 'whatsapp': {
      const phone = parsePhoneNumberFromString(
        raw,
        input.defaultCountry ? (input.defaultCountry.toUpperCase() as CountryCode) : undefined,
      );
      if (!phone?.isValid()) {
        throw new InvalidAddressError(`not a valid phone number: ${input.address}`);
      }
      return { channel: input.channel, address: phone.number, region: phone.country ?? null };
    }

    case 'email': {
      const address = raw.toLowerCase();
      // Enough to catch a mistyped address; the provider is the real judge.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
        throw new InvalidAddressError(`not a valid email address: ${input.address}`);
      }
      return { channel: 'email', address, region: null };
    }

    case 'telegram':
      return { channel: 'telegram', address: raw, region: null };
  }
}
