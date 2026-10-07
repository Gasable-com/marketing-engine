/** What a company does in a supply chain. The column checks the same list. */
export const PROFILE_ROLES = [
  'manufacturer',
  'distributor',
  'wholesaler',
  'retailer',
  'installer',
  'service_provider',
  'transporter',
  'other',
] as const;
export type ProfileRole = (typeof PROFILE_ROLES)[number];
