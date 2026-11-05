# United States coastline

Made with Natural Earth. The source is the **v5.1.2, 1:10m countries dataset**:

https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_admin_0_countries.geojson

Natural Earth data is public domain:
https://www.naturalearthdata.com/about/terms-of-use/

`usa.geojson` is the outline of the United States, including Alaska and Hawaii, without
the edges it shares with other countries or the cuts at the antimeridian. Territories
such as Puerto Rico are separate countries in the source and are not included.

Regenerate with `npm run data:usa-coastline`, or use an already downloaded copy:
`npm run data:usa-coastline -- /path/to/ne_10m_admin_0_countries.geojson`.
