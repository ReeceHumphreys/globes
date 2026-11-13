"""List the EPT nodes over a ground square: key, point count, and node bounds (EPSG:3857).

Usage: python ept_select.py <ept.json url> <lat> <lon> <half-size m> <out.json>
"""
import json, math, sys, urllib.request

url, lat, lon, half, out = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4]), sys.argv[5]
base = url.rsplit("/", 1)[0]
get = lambda u: json.load(urllib.request.urlopen(u, timeout=60))
ept = get(url)
x = lon * 20037508.342789244 / 180
y = math.log(math.tan((90 + lat) * math.pi / 360)) * 6378137
# Web Mercator stretches ground distances by 1 / cos(latitude).
h = half / math.cos(math.radians(lat))
box = (x - h, y - h, x + h, y + h)
b = ept["bounds"]
hierarchy = {}

def load(key):
    hierarchy.update(get(f"{base}/ept-hierarchy/{key}.json"))

def bounds(key):
    d, i, j, k = map(int, key.split("-"))
    s = [(b[a + 3] - b[a]) / 2**d for a in range(3)]
    lo = [b[0] + i * s[0], b[1] + j * s[1], b[2] + k * s[2]]
    return lo + [lo[0] + s[0], lo[1] + s[1], lo[2] + s[2]]

load("0-0-0-0")
selected = []
stack = ["0-0-0-0"]
while stack:
    key = stack.pop()
    count = hierarchy.get(key)
    if count is None:
        continue
    if count == -1:
        load(key)
        count = hierarchy[key]
    nb = bounds(key)
    if nb[3] < box[0] or nb[0] > box[2] or nb[4] < box[1] or nb[1] > box[3]:
        continue
    selected.append({"key": key, "points": count, "bounds": nb})
    d, i, j, k = map(int, key.split("-"))
    for c in range(8):
        stack.append(f"{d+1}-{2*i+(c&1)}-{2*j+(c>>1&1)}-{2*k+(c>>2&1)}")

json.dump({"box": box, "nodes": selected, "base": base, "srs": ept["srs"]}, open(out, "w"))
depths = {}
for n in selected:
    depths.setdefault(int(n["key"].split("-")[0]), [0, 0])
    depths[int(n["key"].split("-")[0])][0] += 1
    depths[int(n["key"].split("-")[0])][1] += n["points"]
for d in sorted(depths):
    print(f"depth {d}: {depths[d][0]} nodes, {depths[d][1]:,} points")
print("total", sum(n["points"] for n in selected), "points in", len(selected), "nodes")
