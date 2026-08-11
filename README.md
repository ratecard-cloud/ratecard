# RateCard

A multi-cloud pricing index. List prices only, every number sourced and dated.

Scoped to the two categories where the spread between providers is widest —
**compute** and **egress**.

```bash
nvm use              # Node 23 (Astro needs >= 20.12 for util.styleText)
npm install
npm run data         # refresh prices from provider APIs
npm run dev          # http://localhost:4321
```

## Why this exists

Provider pricing pages quote an instance price. Nobody's bill is an instance price.
The compute page adds **your** egress volume to the instance cost, and the ranking
inverts as you drag the slider:

| 4 vCPU / 16 GB, US East | at 0 GB egress | at 50 TB egress |
| --- | --- | --- |
| OCI E4.Flex | $54 | $402 |
| Linode g8-dedicated | $153 | $409 |
| AWS m7i.xlarge | $147 | $4,542 |

Same hardware. An 11x difference that no single provider's pricing page will show you.

## Architecture

```
data/
  providers.json         provider registry + region mapping
  regions.json           canonical region keys
  schema.md              record shape and the reasoning behind it
  curated/egress.json    hand-maintained schedules (no API exists)
  raw/<provider>/        raw upstream payloads, committed
  normalized/            compute.json, egress.json, manifest.json
pipeline/
  run.mjs                orchestrator; refuses to write on validation error
  validate.mjs           sanity gates
  lib.mjs, fx.mjs        shared helpers, currency conversion
  collectors/*.mjs       one per provider
src/                     Astro site (static, zero framework JS)
public/compute.js        the grid island: filters, sort, egress slider
```

**Data lives in git, not a database.** Git history *is* the price history — the
v1.1 "historical charts" feature is a `git log` away, the public changelog is the
diff, and every number has an audit trail. Raw upstream payloads are committed
next to the normalized output so the schema can change without re-fetching.

## Data sources

| Provider | Method | Credentials |
| --- | --- | --- |
| AWS | Bulk price list CSV (streamed) | none |
| Azure | Retail Prices API | none |
| OCI | APEX price list API | none |
| Vultr | `/v2/plans` | none |
| Linode | `/v4/linode/types` | none |
| GCP | Cloud Billing Catalog | `GCP_API_KEY` |
| Hetzner | Cloud API | `HETZNER_API_TOKEN` |
| DigitalOcean | `/v2/sizes` | `DO_API_TOKEN` |
| R2 / B2 | curated from docs | — |

Five providers collect with **zero credentials**. The other three are skipped with
a clear message rather than falling back to guessed numbers.

### Credentials

All three are free and read-only. Drop them in `.env` or export them:

```bash
export HETZNER_API_TOKEN=...   # Hetzner Console → Security → API tokens (read)
export DO_API_TOKEN=...        # DigitalOcean → API → Personal access token (read)
export GCP_API_KEY=...         # GCP Console → Credentials, enable Cloud Billing API
```

### AWS caching

The AWS bulk file is ~300 MB per region. Cache it to avoid re-downloading:

```bash
mkdir -p data/cache
curl -o data/cache/aws-ec2-us-east-1.csv \
  https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/us-east-1/index.csv
```

`data/cache/` is gitignored. For CI, the Price List **Query API** (`GetProducts`
with filters) returns the same data in kilobytes but needs SigV4 credentials —
the bulk file is used here so the pipeline runs with no secrets at all.

## Validation

`npm run data` refuses to write if anything fails. It catches unit-conversion bugs
(`$/vCPU/month` outside $0.50–$500), non-ascending egress tiers, unbounded-tier
mistakes, missing source URLs, duplicates, and providers with compute data but no
egress schedule. It warns when hourly × 730 disagrees with the quoted monthly
price — which is how Linode's monthly *billing cap* was found.

Two real data bugs it caught on first run:

- Linode's `g8` generation quotes `monthly: null` (hourly-only billing)
- Linode's `g7` monthly prices are a cap *below* hourly × 730, not a rounding error

## Normalization

The schema refuses to store a machine type without saying what its vCPU actually is:

- `vcpu_type`: `shared` (burstable/credit-limited) vs `dedicated`
- `vcpu_unit`: `thread` (x86 hyperthread) vs `core` (ARM, no SMT)

A Hetzner CCX33 "4 vCPU" is 4 physical cores; an `m7i.xlarge` "4 vCPU" is 2 cores
with SMT. Presenting those as equal specs is the fastest way to lose credibility,
so both appear as columns rather than footnotes.

OCI is priced per-OCPU (a full physical core) and per-GB, so its flex shapes are
*built* to hit the comparison grid rather than accepting OCI's default ratio.
GCP publishes no per-machine-type price at all — its rows are reassembled from
component SKUs and marked `medium` confidence with the arithmetic shown.

## Known gaps

- **Hetzner, DigitalOcean, GCP** need credentials before they appear
- **OCI Ampere (ARM)** part numbers aren't discoverable via the API — manual lookup needed
- **`source_verified_at` is `null` everywhere** — no human has eyeballed the curated
  egress numbers against their source pages yet. Those rows show an `unverified` badge.
- Two regions only (`us-east`, `eu-central`)

## Licensing

Split deliberately, because code and data want different terms:

| | Licence | Covers |
| --- | --- | --- |
| **Code** | [MIT](LICENSE) | collectors, pipeline, site |
| **Data** | [CC BY 4.0](LICENSE-DATA) | everything under `data/` |

Use the dataset for anything, including commercially — just credit it:

> Pricing data from [RateCard](https://ratecard.cloud), CC BY 4.0.

Attribution is the whole point of picking CC BY over public domain. If you
build on this, link back.

Individual prices are facts and facts are not copyrightable in the US, so no
licence can stop you quoting what AWS charges — nor should it. What the licence
covers is the *compilation*: which providers, which comparable shapes, the
normalization rules, the arrangement. [LICENSE-DATA](LICENSE-DATA) is explicit
about where that line falls.

Provider names and logos belong to their owners and are used nominatively.
No affiliation or endorsement is claimed.

## Contributing

Corrections are the most valuable contribution here — a wrong price is the one
failure this site cannot absorb. If a number is off, open an issue or a PR
against the collector; the source link on every row shows what it should be.

Adding a provider means writing one collector in `pipeline/collectors/` that
returns `computeRecord()` objects. The validator will tell you what you got
wrong before anything is written.
