#!/usr/bin/env python3
"""
Generate public/og.png (1200x630) for social previews.

Reads the real dataset so the card cannot drift from the site: the provider
counts and the before/after egress figures are whatever the last pipeline run
produced. Re-run after a data refresh if the headline numbers matter.

    python3 pipeline/og-image.py
"""
import json
import pathlib
from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
W, H = 1200, 630

# Site dark palette — dark cards hold up better against both feed themes.
BG = "#0d0f13"
FG = "#e8ebf0"
MUTED = "#99a2b0"
FAINT = "#6c7481"
ACCENT = "#62a8f5"
WARN = "#e0a34a"
INSET = "#1b1f27"

FONTS = [
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/HelveticaNeue.ttc",
    "/System/Library/Fonts/SFNS.ttf",
]


def font(size, bold=False):
    for path in FONTS:
        try:
            # Helvetica.ttc: index 0 regular, 1 bold.
            return ImageFont.truetype(path, size, index=1 if bold else 0)
        except Exception:
            continue
    return ImageFont.load_default()


def egress_cost(sched, gb):
    if not sched:
        return 0.0
    remaining = max(0.0, gb - (sched.get("free_gb_per_month") or 0))
    cost, floor = 0.0, 0.0
    for tier in sched["tiers"]:
        if remaining <= 0:
            break
        cap = tier["up_to_gb"]
        span = float("inf") if cap is None else cap - floor
        used = min(remaining, span)
        cost += used * tier["usd_per_gb"]
        remaining -= used
        floor = floor if cap is None else cap
    return round(cost, 2)


def load():
    d = ROOT / "data" / "normalized"
    compute = json.loads((d / "compute.json").read_text())
    egress = json.loads((d / "egress.json").read_text())
    providers = json.loads((ROOT / "data" / "providers.json").read_text())
    return compute, egress, providers


def main():
    compute, egress, providers = load()
    GB = 20480  # 20 TB — the volume where the ranking argument is clearest

    rows = []
    for r in compute:
        if r["region"] != "us-east" or r["vcpu"] != 4 or r["ram_gb"] != 16:
            continue
        sched = next(
            (e for e in egress if e["provider"] == r["provider"] and e["region"] == r["region"]),
            None,
        )
        billable = max(0, GB - (r.get("included_egress_gb") or 0))
        base = r["price_monthly_usd"]
        rows.append((providers[r["provider"]]["short"], base, base + egress_cost(sched, billable)))

    rows.sort(key=lambda x: x[2])
    # One row per provider, cheapest first — the card has room for four.
    seen, picks = set(), []
    for short, base, total in rows:
        if short in seen:
            continue
        seen.add(short)
        picks.append((short, base, total))
        if len(picks) == 4:
            break

    n_prices = len(compute)
    n_providers = len({r["provider"] for r in compute})

    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # Accent hairline along the top.
    d.rectangle([0, 0, W, 5], fill=ACCENT)

    x = 72
    d.text((x, 62), "Rate", font=font(38, True), fill=FG)
    rate_w = d.textlength("Rate", font=font(38, True))
    d.text((x + rate_w, 62), "Card", font=font(38, True), fill=ACCENT)

    d.text((x, 140), "Cloud pricing, with the", font=font(62, True), fill=FG)
    d.text((x, 208), "egress tax included.", font=font(62, True), fill=FG)

    d.text(
        (x, 300),
        "4 vCPU / 16 GB in US East, with 20 TB of outbound traffic",
        font=font(24),
        fill=MUTED,
    )

    # Bars: instance cost in grey, egress in amber, scaled to the dearest total.
    top = 346
    row_h = 52
    bar_x = x + 132
    bar_max = 640
    worst = max((t for _, _, t in picks), default=1) or 1

    for i, (short, base, total) in enumerate(picks):
        y = top + i * row_h
        d.text((x, y + 4), short, font=font(23, True), fill=FG)
        base_w = max(4, int(bar_x + (base / worst) * bar_max) - bar_x)
        d.rounded_rectangle([bar_x, y, bar_x + base_w, y + 27], radius=4, fill=INSET)
        eg_w = int(((total - base) / worst) * bar_max)
        if eg_w > 1:
            d.rounded_rectangle(
                [bar_x + base_w, y, bar_x + base_w + eg_w, y + 27], radius=4, fill=WARN
            )
        # Helvetica has no U+2192, so the arrow is drawn rather than typed —
        # otherwise it renders as a tofu box on the card.
        lx = bar_x + base_w + max(eg_w, 0) + 14
        f_lab = font(21, True)
        left = f"${base:,.0f}"
        d.text((lx, y + 3), left, font=f_lab, fill=MUTED)
        ax = lx + d.textlength(left, font=f_lab) + 10
        ay = y + 16
        d.line([ax, ay, ax + 18, ay], fill=FAINT, width=2)
        d.polygon([(ax + 18, ay - 4), (ax + 24, ay), (ax + 18, ay + 4)], fill=FAINT)
        d.text((ax + 32, y + 3), f"${total:,.0f}", font=f_lab, fill=FG)

    d.text(
        (x, H - 74),
        f"{n_prices} list prices · {n_providers} providers · updated daily · sourced and dated",
        font=font(21),
        fill=FAINT,
    )
    d.text((x, H - 44), "ratecard.cloud", font=font(21, True), fill=ACCENT)

    out = ROOT / "public" / "og.png"
    img.save(out, "PNG", optimize=True)
    print(f"wrote {out.relative_to(ROOT)}  {out.stat().st_size // 1024} KB  {W}x{H}")
    for short, base, total in picks:
        print(f"   {short:<9} ${base:,.2f} -> ${total:,.2f}")


if __name__ == "__main__":
    main()
