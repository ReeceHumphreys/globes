"""Convert the EPT nodes listed by ept_select.py into a 3D Tiles 1.0 point-cloud tileset.

Each EPT node becomes one .pnts tile with additive refinement, so the EPT octree's level of
detail carries over unchanged. Points are cropped to the selection square, noise classes
are dropped, and colors come from classification shaded by intensity.

Usage: python ept_to_3dtiles.py <nodes.json> <out dir> <geoid height m>

Heights in the source are NAVD88 (orthometric). Adding the GEOID18 geoid height at the site
makes them heights above the NAD83(2011) ellipsoid, which this treats as WGS84.
shortcut: one geoid height for the whole site, and NAD83(2011) taken as WGS84 (about a
meter apart in Texas); use a GEOID18 grid and a datum transform for survey accuracy.
"""
import io, json, math, os, struct, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor

import laspy
import numpy as np

nodes_path, out, geoid = sys.argv[1], sys.argv[2], float(sys.argv[3])
selection = json.load(open(nodes_path))
base, box = selection["base"], selection["box"]

A, F = 6378137.0, 1 / 298.257223563
E2 = F * (2 - F)
NOISE = {7, 18}
# ASPRS classes: 1 unclassified, 2 ground, 3-5 vegetation, 6 building, 9 water, 17 bridge.
PALETTE = np.full((256, 3), (180, 180, 180), dtype=np.float32)
PALETTE[1] = (225, 225, 225)
PALETTE[2] = (196, 170, 128)
PALETTE[3:6] = (96, 150, 80)
PALETTE[6] = (230, 140, 70)
PALETTE[9] = (70, 120, 200)
PALETTE[17] = (200, 200, 120)


def ecef(x, y, z):
    """Web Mercator x, y and ellipsoidal height to Earth-centered meters."""
    lon = x / A
    lat = np.pi / 2 - 2 * np.arctan(np.exp(-y / A))
    n = A / np.sqrt(1 - E2 * np.sin(lat) ** 2)
    return np.stack(
        [
            (n + z) * np.cos(lat) * np.cos(lon),
            (n + z) * np.cos(lat) * np.sin(lon),
            (n * (1 - E2) + z) * np.sin(lat),
        ],
        axis=1,
    ), lon, lat


def fetch(key):
    data = urllib.request.urlopen(f"{base}/ept-data/{key}.laz", timeout=120).read()
    las = laspy.read(io.BytesIO(data))
    x, y, z = np.asarray(las.x), np.asarray(las.y), np.asarray(las.z)
    keep = (x >= box[0]) & (x <= box[2]) & (y >= box[1]) & (y <= box[3])
    cls = np.asarray(las.classification)
    keep &= ~np.isin(cls, list(NOISE))
    intensity = np.asarray(las.intensity, dtype=np.float32)[keep]
    return key, len(data), x[keep], y[keep], z[keep] + geoid, cls[keep], intensity


def pnts(points, colors):
    lo, hi = points.min(axis=0), points.max(axis=0)
    scale = np.maximum(hi - lo, 1e-3)
    quantized = np.round((points - lo) / scale * 65535).astype("<u2")
    header = {
        "POINTS_LENGTH": len(points),
        "POSITION_QUANTIZED": {"byteOffset": 0},
        "QUANTIZED_VOLUME_OFFSET": lo.tolist(),
        "QUANTIZED_VOLUME_SCALE": scale.tolist(),
        "RGB": {"byteOffset": quantized.nbytes},
    }
    body = quantized.tobytes() + colors.astype(np.uint8).tobytes()
    body += b"\0" * (-len(body) % 8)
    text = json.dumps(header).encode()
    text += b" " * (-(28 + len(text)) % 8)
    return (
        b"pnts"
        + struct.pack("<6I", 1, 28 + len(text) + len(body), len(text), len(body), 0, 0)
        + text
        + body
    )


os.makedirs(out, exist_ok=True)
info, downloaded = {}, 0
with ThreadPoolExecutor(8) as pool:
    for key, size, x, y, z, cls, intensity in pool.map(fetch, [n["key"] for n in selection["nodes"]]):
        downloaded += size
        if len(x) == 0:
            continue
        points, lon, lat = ecef(x, y, z)
        shade = np.clip(intensity / max(np.percentile(intensity, 98), 1), 0.35, 1.0)
        colors = PALETTE[cls] * shade[:, None]
        with open(os.path.join(out, f"{key}.pnts"), "wb") as f:
            f.write(pnts(points, colors))
        info[key] = {
            "count": len(x),
            "region": [lon.min(), lat.min(), lon.max(), lat.max(), z.min(), z.max()],
        }

# The tile tree follows the EPT keys. A node with no points kept still links its children.

selected = {n["key"] for n in selection["nodes"]}


def tile(key):
    if key not in selected:
        return None
    d, i, j, k = map(int, key.split("-"))
    children = [
        t
        for c in range(8)
        if (t := tile(f"{d+1}-{2*i+(c&1)}-{2*j+(c>>1&1)}-{2*k+(c>>2&1)}")) is not None
    ]
    if key not in info and not children:
        return None
    regions = [c["boundingVolume"]["region"] for c in children]
    if key in info:
        regions.append(info[key]["region"])
    region = [min(r[0] for r in regions), min(r[1] for r in regions), max(r[2] for r in regions),
              max(r[3] for r in regions), min(r[4] for r in regions), max(r[5] for r in regions)]
    node = {
        "boundingVolume": {"region": region},
        "geometricError": 0 if not children else root_spacing / 2**d,
        "refine": "ADD",
    }
    if key in info:
        node["content"] = {"uri": f"{key}.pnts"}
    if children:
        node["children"] = children
    return node


# Ground spacing of the root node: its width over the EPT span of 128, in meters, doubled
# as the error of drawing it without its children. Each level halves it.
root_bounds = selection["nodes"][0]["bounds"]
latitude = math.pi / 2 - 2 * math.atan(math.exp(-(box[1] + box[3]) / 2 / A))
root_spacing = (root_bounds[3] - root_bounds[0]) * math.cos(latitude) / 128 * 2
root = tile("0-0-0-0")
json.dump(
    {"asset": {"version": "1.0"}, "geometricError": root_spacing * 2, "root": root},
    open(os.path.join(out, "tileset.json"), "w"),
)
total = sum(v["count"] for v in info.values())
print(f"downloaded {downloaded/1e6:.1f} MB, kept {total:,} points in {len(info)} tiles -> {out}")
