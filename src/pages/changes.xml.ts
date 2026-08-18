import type { APIRoute } from 'astro';
import { changesByDate } from '../lib/history';
import { PROVIDERS, usd } from '../lib/data';

/**
 * RSS is the no-infrastructure alert channel: readers, Slack RSS apps and
 * Zapier all speak it, and it costs us a static file. One item per day keeps
 * a DO capacity flap from becoming 24 separate notifications.
 */
const short = (p: string) => PROVIDERS[p]?.short ?? p;
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function line(c: any): string {
  switch (c.type) {
    case 'price_changed':
      return `PRICE ${short(c.provider)} ${c.sku} (${c.region}): ${usd(c.monthly_old)} -> ${usd(c.monthly_new)}/mo`;
    case 'sku_added': return `added ${short(c.provider)} ${c.sku} (${c.region}) at ${usd(c.monthly)}/mo`;
    case 'sku_removed': return `removed ${short(c.provider)} ${c.sku} (${c.region})`;
    case 'allowance_changed':
      return `allowance ${short(c.provider)} ${c.sku} (${c.region}): ${c.included_gb_old} -> ${c.included_gb_new} GB`;
    default: return `${c.type.replace('_', ' ')} ${short(c.provider)} (${c.region})`;
  }
}

export const GET: APIRoute = () => {
  const items = changesByDate(200).map(([date, events]) => {
    const prices = events.filter((e) => e.type === 'price_changed').length;
    const title = prices
      ? `${date}: ${prices} price change(s), ${events.length - prices} coverage event(s)`
      : `${date}: ${events.length} coverage event(s)`;
    const body = events.map((e) => `<li>${esc(line(e))}</li>`).join('');
    return `  <item>
    <title>${esc(title)}</title>
    <link>https://ratecard.cloud/changes</link>
    <guid isPermaLink="false">ratecard-changes-${date}</guid>
    <pubDate>${new Date(date + 'T06:00:00Z').toUTCString()}</pubDate>
    <description><![CDATA[<ul>${body}</ul>]]></description>
  </item>`;
  });

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>RateCard — cloud price changes</title>
  <link>https://ratecard.cloud/changes</link>
  <description>Daily changelog of cloud list-price and coverage changes across ${Object.keys(PROVIDERS).length} providers.</description>
${items.join('\n')}
</channel>
</rss>
`,
    { headers: { 'content-type': 'application/rss+xml; charset=utf-8' } },
  );
};
