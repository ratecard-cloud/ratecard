# Deploying RateCard

Primary domain: **ratecard.cloud**
Hosting: **Cloudflare Pages** (free tier, unlimited bandwidth)
Collectors: **GitHub Actions**, daily

## Why Cloudflare Pages

Unlimited bandwidth is the deciding factor. A Hacker News front page is exactly
when this site must not be throttled or bill-shocked. Netlify (100 GB/mo) and
Vercel (100 GB/mo, and Hobby forbids commercial use — which ads and affiliate
links are) both meter the thing we cannot afford to meter.

**This creates a disclosed conflict of interest.** Cloudflare R2 tops the egress
table on merit — it genuinely charges zero egress — and we host with Cloudflare.
That is named in the Independence section of `/methodology`. Any host fast and
cheap enough to run this site is a company the site indexes; the answer is
disclosure, not pretending otherwise. Pay list price, take no credits.

## 1. Pages setup

Connect the GitHub repo in the Cloudflare dashboard (Workers & Pages → Create →
Pages → Connect to Git), then:

| Setting | Value |
| --- | --- |
| Build command | `npm run build` |
| Output directory | `dist` |
| Node version | `23` (env var `NODE_VERSION=23`) |

Astro needs Node ≥ 20.12 for `util.styleText`; Pages defaults older, so set
`NODE_VERSION` explicitly or the build fails with a confusing module error.

Add `ratecard.cloud` and `www.ratecard.cloud` under Custom domains.

## 2. Repository secrets

Settings → Secrets and variables → Actions:

```
HETZNER_API_TOKEN    Hetzner Console → Security → API tokens (read-only)
DO_API_TOKEN         DigitalOcean → API → Personal access token (read scope)
GCP_API_KEY          GCP Console → Credentials, with Cloud Billing API enabled
```

All three are free. Until they exist those collectors skip with a message rather
than emitting guessed prices.

## 3. Redirects

Add each redirect domain to Cloudflare as its own zone (free plan is fine), then
Rules → Redirect Rules. Free plan allows 10 single redirect rules.

### egresstax.com → the egress page

Worth having. It is a campaign hook for launch posts, not a traffic source:
"the egress tax" is the memorable half of the pitch, and a bare domain in an HN
comment reads better than a deep link.

```
When:  (http.host eq "egresstax.com" or http.host eq "www.egresstax.com")
Then:  Static redirect → https://ratecard.cloud/egress
       Status 301, preserve query string
```

### cloudpricelist.com → root

```
When:  (http.host eq "cloudpricelist.com" or http.host eq "www.cloudpricelist.com")
Then:  Dynamic redirect
       concat("https://ratecard.cloud", http.request.uri.path)
       Status 301, preserve query string
```

**Be clear-eyed about what this buys.** A brand-new domain has no accumulated
authority, so a 301 from it passes essentially no SEO value, and nobody types
`cloudpricelist.com` unprompted. Its value is entirely:

1. **Defensive** — denies a competitor the obvious descriptive name in the niche.
2. **Optionality** — if "RateCard" hasn't landed in six months, it is a ready
   fallback with clearer instant comprehension.

That is worth ~$12/yr if $12 is noise, but do not expect traffic from it, and
**do not serve the site on both domains.** Duplicate content across two hosts
splits ranking signals and is a genuine SEO own-goal. One canonical origin,
301 everything else.

## 4. Deploys are automatic

The daily Actions run commits refreshed prices to `main`; the Pages git
integration rebuilds on that push. No deploy step in the workflow.

Note that pushes made with the default `GITHUB_TOKEN` do **not** trigger other
GitHub Actions workflows. This does not affect Pages (external webhook), but if
you later add a deploy workflow triggered `on: push`, it will silently never run.

To deploy from CI instead of giving Cloudflare repo access:

```bash
npx wrangler pages deploy dist --project-name=ratecard
```

with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in secrets.

## Running cost

| Item | Cost |
| --- | --- |
| ratecard.cloud | ~$20–40/yr (verify — `.cloud` renewal can differ from year one) |
| egresstax.com | ~$11/yr |
| cloudpricelist.com | ~$12/yr, optional |
| Cloudflare Pages | $0 |
| GitHub Actions | $0 (unlimited on public repos) |
| All pricing APIs | $0 |

Roughly **$45/yr all-in**, which is what makes the low-traffic revenue case
survivable.
