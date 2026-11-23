"""Independent reference implementation of the FloodScope classification, used to check the browser engine.

It shares no code with js/: data are read and resampled with GDAL (rasterio WarpedVRT), speckle filtering uses
scipy.ndimage.uniform_filter on a NaN-aware sum, slope uses numpy.gradient-free Horn kernels via scipy.ndimage.correlate,
and areas and population are summed with numpy. Usage:

    python3 pipeline/reference.py PRE_DATE POST_DATE W S E N OUT.json

Dates are YYYY-MM-DD of Sentinel-1 RTC acquisitions on the same relative orbit."""
import json, sys, math
import numpy as np, rasterio, planetary_computer as pc, pystac_client
from rasterio.vrt import WarpedVRT
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.features import rasterize
from scipy import ndimage
from pyproj import Transformer
from shapely.geometry import box, mapping
from shapely.ops import transform as shp_transform

P = dict(speckle=3, threshold=-18.0, change=-3.0, slope_max=5.0, perm=80.0)
pre_d, post_d, W, S, E, N, out = sys.argv[1], sys.argv[2], *map(float, sys.argv[3:7]), sys.argv[7]
cat = pystac_client.Client.open("https://planetarycomputer.microsoft.com/api/stac/v1", modifier=pc.sign_inplace)
aoi = box(W, S, E, N)

def s1(day):
    """All slices of that day's acquisition over the box (same platform and relative orbit)."""
    it = list(cat.search(collections=["sentinel-1-rtc"], bbox=[W, S, E, N], datetime=f"{day}T00:00:00Z/{day}T23:59:59Z").items())
    if not it: sys.exit(f"no Sentinel-1 RTC scene on {day}")
    k = lambda i: (i.properties["platform"], i.properties["sat:relative_orbit"], i.properties["sat:orbit_state"])
    return [i for i in it if k(i) == k(it[0])]

pre, post = s1(pre_d), s1(post_d)
epsg = post[0].properties.get("proj:epsg") or int(str(post[0].properties["proj:code"]).split(":")[1])
to_utm = Transformer.from_crs(4326, epsg, always_xy=True).transform
a_utm = shp_transform(to_utm, aoi)
area_km2 = shp_transform(Transformer.from_crs(4326, 6933, always_xy=True).transform, aoi).area / 1e6  # EASE-Grid 2.0, equal area
res = 20.0 if area_km2 <= 900 else 40.0
minx, miny, maxx, maxy = a_utm.bounds
x0, y1 = math.floor(minx / res) * res, math.ceil(maxy / res) * res
w, h = math.ceil((maxx - x0) / res), math.ceil((y1 - miny) / res)
T = from_origin(x0, y1, res, res)
inside = rasterize([(mapping(a_utm), 1)], out_shape=(h, w), transform=T, fill=0, all_touched=False).astype(bool)

def read(href, rs, band=1):
    with rasterio.open(href) as src, WarpedVRT(src, crs=f"EPSG:{epsg}", transform=T, width=w, height=h, resampling=rs,
                                              src_nodata=src.nodata, nodata=np.nan, dtype="float32") as v:
        return v.read(band)

def mosaic(items, key, rs):
    out = np.full((h, w), np.nan, "float32")
    for it in items:
        a = read(it.assets[key].href, rs); m = np.isnan(out) & ~np.isnan(a); out[m] = a[m]
    return out

def to_db_filtered(lin):
    lin = np.where(lin > 0, lin, np.nan)
    ok = ~np.isnan(lin)
    s = ndimage.uniform_filter(np.where(ok, lin, 0).astype("float64"), P["speckle"], mode="constant")
    n = ndimage.uniform_filter(ok.astype("float64"), P["speckle"], mode="constant")
    with np.errstate(invalid="ignore", divide="ignore"):
        m = np.where(ok & (n > 0), s / n, np.nan)
        return 10 * np.log10(m)

db = {k: to_db_filtered(mosaic(items, pol, Resampling.average)) for k, items, pol in
      [("preVV", pre, "vv"), ("postVV", post, "vv"), ("preVH", pre, "vh"), ("postVH", post, "vh")]}
for k in db: db[k][~inside] = np.nan

search = lambda c, **kw: list(cat.search(collections=[c], bbox=[W, S, E, N], **kw).items())
occ = mosaic(search("jrc-gsw"), "occurrence", Resampling.nearest)
z = mosaic(search("cop-dem-glo-30"), "data", Resampling.bilinear)
zp = np.pad(z, 1, mode="edge")
kx = np.array([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]]) / (8 * res)
ky = np.array([[-1, -2, -1], [0, 0, 0], [1, 2, 1]]) / (8 * res)
dzdx, dzdy = ndimage.correlate(zp, kx)[1:-1, 1:-1], ndimage.correlate(zp, ky)[1:-1, 1:-1]
slope = np.degrees(np.arctan(np.hypot(dzdx, dzdy)))
lc = mosaic(search("esa-worldcover", datetime="2021-01-01/2021-12-31"), "map", Resampling.nearest)

# population: GHS-POP tiles shipped with the app, counts per 30" cell -> density per km2 by latitude band
import glob
pop = np.full((h, w), np.nan, "float32")
for f in sorted(glob.glob("data/population/pop2025_*.tif")):
    with rasterio.open(f) as src:
        b = src.bounds
        if b.left >= E or b.right <= W or b.bottom >= N or b.top <= S: continue
    a = read(f, Resampling.nearest); m = np.isnan(pop) & ~np.isnan(a); pop[m] = a[m]
rows_y = y1 - (np.arange(h) + 0.5) * res
lat = np.array(Transformer.from_crs(epsg, 4326, always_xy=True).transform(np.full(h, x0 + w * res / 2), rows_y)[1])
# area of each 30" cell on the WGS 84 ellipsoid, computed independently with pyproj's geodesic polygon area
from pyproj import Geod
geod, d = Geod(ellps="WGS84"), 30 / 3600
cell = np.array([abs(geod.polygon_area_perimeter([0, d, d, 0], [la - d / 2, la - d / 2, la + d / 2, la + d / 2])[0]) / 1e6 for la in lat])
dens = pop / cell[:, None]; dens[~inside] = np.nan

# classification (methodology section 4)
valid = ~np.isnan(db["preVV"]) & ~np.isnan(db["postVV"])
perm = valid & (occ >= P["perm"]) & (occ <= 100)
steep = valid & ~perm & (slope > P["slope_max"])
cand = valid & ~perm & ~steep
flood = cand & (db["postVV"] < P["threshold"]) & (db["postVV"] - db["preVV"] <= P["change"])
high = flood & (db["postVH"] - db["preVH"] <= P["change"])
before = cand & ~flood & (db["preVV"] < P["threshold"])
cls = np.zeros((h, w), "uint8"); cls[valid] = 1; cls[high] = 2; cls[flood & ~high] = 3; cls[perm] = 4; cls[steep] = 5; cls[before] = 6
# ground area per pixel: UTM map area / k^2, with k from pyproj's projection factors at each column centre
from pyproj import Proj
cols_e = x0 + (np.arange(w) + 0.5) * res
lon_c, lat_c = Transformer.from_crs(epsg, 4326, always_xy=True).transform(cols_e, np.full(w, y1 - h * res / 2))
k = np.array(Proj(f"EPSG:{epsg}").get_factors(lon_c, lat_c).meridional_scale)
A = np.broadcast_to((res * res / k ** 2 / 1e6)[None, :], (h, w))
pp = np.where(np.isnan(dens), 0, dens) * A
summary = {"grid": [w, h, res, epsg, x0, y1],
           "areaKm2": {"valid": float(A[valid].sum()), "flood": float(A[flood].sum()), "floodHigh": float(A[high].sum()),
                       "permanent": float(A[perm].sum()), "steep": float(A[steep].sum()), "waterBefore": float(A[before].sum())},
           "population": {"inFlood": float(pp[flood].sum()), "inValidArea": float(pp[valid].sum()), "inAoi": float(pp[inside].sum())},
           "landcoverKm2": {str(int(v)): float(A[flood & (lc == v)].sum()) for v in np.unique(lc[flood]) if v == v}}
json.dump({"summary": summary, "cls": cls.ravel().tolist()}, open(out, "w"))
print(json.dumps(summary, indent=1))
