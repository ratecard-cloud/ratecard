# Affiliate links

The mechanism is built and inert. Nothing renders until a referral URL is added
to `data/providers.json`, and no such URL is set today.

## Adding one

1. Sign up for the provider's referral programme and get your link.
2. Put it in `data/providers.json` under that provider's `affiliate` key:

```jsonc
"hetzner": {
  "short": "Hetzner",
  "affiliate": "https://hetzner.cloud/?ref=YOURCODE",
  ...
}
```

3. `npm run data` — validation will reject the build if the URL is not https, or
   if it matches the provider's `url` (which would mean the source links had
   quietly become monetised).
4. Rebuild. A "Signing up" block appears below the tables on `/compute` and
   `/egress`, listing only providers with a link set.

## Which providers have programmes

Worth checking directly; terms change and none of this is verified here.

| Provider | Programme | Notes |
| --- | --- | --- |
| DigitalOcean | yes | Referral programme, credit-based for the referee |
| Vultr | yes | Referral programme |
| Hetzner | yes | Gives the referee account credit |
| Linode / Akamai | yes | Referral programme |
| AWS, Azure, GCP, OCI | no meaningful self-serve programme | Indexed identically regardless |
| Cloudflare, Backblaze | check current terms | B2 has had a programme historically |

Payouts in this category are small per conversion. Treat affiliates as covering
running costs rather than as revenue.

## Rules the code enforces

These are not conventions, they are wired in:

- **Not in the price tables.** `ProviderSignup.astro` is the only component that
  renders an affiliate link, and it is placed below the tables. The tables are
  why anyone trusts the site.
- **Source links stay clean.** Every row's `source ↗` points at the provider's
  own pricing page with `rel="nofollow noopener"` and no tracking. The pipeline
  fails the build if `affiliate === url` for any provider.
- **Always marked.** The single component always emits the `aff` chip and
  `rel="sponsored nofollow noopener"`. `sponsored` is what Google requires for
  paid links; plain `nofollow` is not sufficient and risks a manual action.
- **Never affects ordering.** Sorting reads price fields only. Nothing in the
  ranking path reads `affiliate`.

## If you add one, update the disclosure

`/methodology#independence` describes the affiliate policy in specifics. The
pipeline prints a warning listing every provider with an active link, as a
reminder to re-read that section and confirm it is still accurate.

Adding affiliates does not conflict with the footer's claim that "no provider
pays for inclusion, placement, or ranking" — a referral fee on a signup is not
payment for placement. But that distinction only stays true if the four rules
above keep holding.
