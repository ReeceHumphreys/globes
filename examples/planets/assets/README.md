`stbn.bin` is the sampling-noise volume used by Takram's WebGPU atmosphere.
Source: https://github.com/takram-design-engineering/three-geospatial/blob/9627216cc50057994c98a2118f3c4a23765d43b9/packages/core/assets/stbn.bin
It is bundled locally so rendering does not depend on a GitHub request.
Upstream project: https://github.com/takram-design-engineering/three-geospatial (MIT).

`earth-clouds-2048.jpg` is NASA Visible Earth's Blue Marble cloud composite
(2048x1024), used only to guide the cloud volume's density. It is static weather,
not live coverage or retrieved cloud height.
Source page: https://visibleearth.nasa.gov/images/57747/blue-marble-clouds/77558l
Source file: https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57747/cloud_combined_2048.jpg
Credit: NASA/Goddard Space Flight Center, Reto Stöckli.
Bundled locally so the viewer does not depend on NASA's image server.
