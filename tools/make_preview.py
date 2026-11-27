"""Build the landing-page preview card from a real run's exports.

Usage: python3 tools/make_preview.py STATS.csv RECORD.json MAP.png
The three files are the Statistics, Processing record and Map image exports of one run (the Lokoja example).
Writes assets/preview.json (figures shown on the card) and assets/preview-map.webp (a crop of the map image).
"""
import csv, json, sys
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
rows = {(r["section"], r["item"]): r["value"] for r in csv.DictReader(open(sys.argv[1], newline=""))}
rec = json.loads(Path(sys.argv[2]).read_text())
meta = rec.get("meta", rec)
out = {
    "label": meta.get("label"), "version": meta.get("version"),
    "pre": rows[("run", "before")], "post": rows[("run", "after")],
    "flood": round(float(rows[("area", "flood (all)")]), 2), "floodHigh": round(float(rows[("area", "flood, high confidence")]), 2),
    "residents": round(float(rows[("population", "modelled residents in flood")])) if rows[("population", "modelled residents in flood")] else None,
    "threshold": float(rows[("run", "VV water threshold")]),
}
(root / "assets/preview.json").write_text(json.dumps(out, indent=1) + "\n")
im = Image.open(sys.argv[3]).convert("RGB")
w, h = im.size
crop = im.crop((int(w * 0.18), int(h * 0.12), int(w * 0.82), int(h * 0.70)))   # the middle of the map, above the legend and footer
crop.resize((600, round(600 * crop.height / crop.width)), Image.LANCZOS).save(root / "assets/preview-map.webp", quality=82)
print(json.dumps(out))
