# RateCard data schema

Two normalized datasets, both plain JSON in git. Git history *is* the price history —
every pipeline run commits a diff, which is also the public changelog.

## Raw retention policy

`data/raw/` holds upstream payloads so the normalizer can change without re-fetching.
Because the pipeline commits daily, **raw is kept in proportion to how expensive the
source is to re-fetch**, not "save everything just in case":

| Source cost | Policy |
| --- | --- |
| Free, unauthenticated, seconds (Azure, Vultr, Linode, OCI) | Save only the SKUs actually indexed |
| Large or rate-limited (AWS 300 MB/region) | Save the filtered match set; bulk file stays in gitignored `data/cache/` |

Azure's unfiltered region response is ~9k items (~6 MB). Committing that daily added
~4.5 GB of history per year for data never read. Keep the whole tree under ~1 MB.

## Trust fields (on every record)

| Field | Meaning |
|---|---|
| `source_url` | Direct link to the provider's own pricing page or API. Required. |
| `collected_at` | ISO8601. When an automated collector last fetched this. |
| `source_verified_at` | ISO8601 or `null`. When a **human** last eyeballed this against the source. |
| `confidence` | `high` = live provider API. `medium` = curated from official docs. `low` = derived/estimated. |
| `notes` | Array of strings surfaced as expandable footnotes in the UI. |

`collected_at` and `source_verified_at` are deliberately separate. An automated fetch and a
human check are different trust claims and the UI must not conflate them.

## `compute.json`

```jsonc
{
  "provider": "vultr",              // key into providers.json
  "region": "us-east",              // canonical region key
  "region_code": "ewr",             // provider's own code
  "sku": "vc2-2c-4gb",              // provider's machine type id
  "display_name": "Regular 2C/4GB",
  "vcpu": 2,
  "vcpu_type": "shared",            // shared | dedicated  <- NOT comparable across this line
  "vcpu_unit": "thread",            // thread | core       <- an AWS "vCPU" is a hyperthread
  "ram_gb": 4,
  "arch": "x86_64",                 // x86_64 | arm64
  "local_storage_gb": 80,           // 0 if network-storage-only
  "included_egress_gb": 3072,       // bundled outbound transfer; 0 if none
  "price_hourly_usd": 0.0286,
  "price_monthly_usd": 20.0,        // 730h where the provider bills hourly
  "currency": "USD"
  // + trust fields
}
```

### Why `vcpu_type` / `vcpu_unit` are required

A Hetzner CCX33 "4 vCPU" is 4 dedicated physical cores. An AWS `m7i.xlarge` "4 vCPU" is
2 physical cores with SMT. Presenting those as an equal-spec comparison is the single
easiest way to lose credibility, so the schema refuses to store a machine type without
saying which it is. The UI renders it as a column, not a footnote.

## `egress.json`

```jsonc
{
  "provider": "aws",
  "region": "us-east",
  "free_gb_per_month": 100,         // free allowance before tier 1 applies
  "tiers": [                        // ascending, cumulative-volume tiers
    { "up_to_gb": 10240, "usd_per_gb": 0.09 },
    { "up_to_gb": null,  "usd_per_gb": 0.05 }   // null = unbounded final tier
  ],
  "bundled_with_compute": false     // true for Hetzner/Vultr/Linode/DO style allowances
  // + trust fields
}
```

`bundled_with_compute: true` means the real allowance lives on the compute record
(`included_egress_gb`) and this entry only prices the *overage*.

## Effective cost

The site's headline number, computed at render time:

```
effective_monthly = price_monthly_usd
                  + egress_cost(max(0, workload_egress_gb
                                      - included_egress_gb
                                      - free_gb_per_month))
```

This is the whole point of the site. At 5 TB/month of egress the ranking inverts
completely versus a naive `$/month` sort.
