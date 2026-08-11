import { getJSON, saveRaw, round } from './lib.mjs';

/**
 * ECB reference rates via frankfurter.app — free, no key, no rate limit.
 *
 * Any converted price is inherently a snapshot: EUR-billed providers like Hetzner
 * do not reprice when FX moves, so a USD figure for them is our arithmetic, not
 * their list price. Records built from a conversion must say so in `notes` and
 * carry the rate and its date.
 */
let cache = null;

export async function usdRates() {
  if (cache) return cache;
  const body = await getJSON('https://api.frankfurter.app/latest?from=EUR&to=USD');
  await saveRaw('_fx', 'eur-usd', body);
  cache = { EUR: body.rates.USD, date: body.date, USD: 1 };
  return cache;
}

export async function toUSD(amount, currency) {
  if (amount == null) return null;
  if (currency === 'USD') return round(amount, 6);
  const rates = await usdRates();
  const rate = rates[currency];
  if (!rate) throw new Error(`no FX rate for ${currency}`);
  return round(amount * rate, 6);
}

export async function fxNote(currency) {
  if (currency === 'USD') return null;
  const { date, [currency]: rate } = await usdRates();
  return `Billed in ${currency}. Converted at ECB reference rate ${rate} ${currency}/USD on ${date}; the provider does not reprice with FX.`;
}
