# Star background

`nasa-starmap-4k.jpg` is the unmodified 4096 × 2048 celestial-coordinate JPEG
from NASA SVS **Deep Star Maps**, released January 17, 2012.

- Source: https://svs.gsfc.nasa.gov/3895/
- Download: https://svs.gsfc.nasa.gov/vis/a000000/a003800/a003895/starmap_4k.jpg
- Credit: NASA/Goddard Space Flight Center Scientific Visualization Studio.
- Visualizers: Ernie Wright and Tom Bridgman.
- NASA reproduction guidelines: https://www.nasa.gov/nasa-brand-center/images-and-media/

The viewer serves this locally and loads it after the first globe render. It
uses spherical background mapping, without lighting the terrain. The stars
come from catalogs; their orientation in this viewer is illustrative, not a
date-dependent Moon-fixed to celestial-frame transformation.

The viewer dims the panorama to 4% intensity to avoid a bright Milky Way haze
beside sunlit terrain. This is a visual exposure adjustment; the JPEG is not a
calibrated radiance map. A photographic exposure for the lit Moon would normally
hide most or all stars: https://science.nasa.gov/blogs/earth-matters/2011/09/28/where-are-the-stars/
