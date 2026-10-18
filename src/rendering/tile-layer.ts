import { createTerrainCompute, type TerrainCompute } from "./terrain-compute.ts";
import type { TerrainLighting } from "../composition.ts";
import {
  terrainCacheSettings,
  RENDER_BINDING_STRIDE,
  type TerrainCacheOptions,
} from "./terrain-cache-state.ts";
import type { StreamingView } from "../imagery/priority.ts";
import cachedNormalShader from "./shaders/cached-normal.wgsl?raw";
import normalGradientShader from "./shaders/normal-from-gradient.wgsl?raw";
import cachedSunlightShader from "./shaders/cached-sunlight.wgsl?raw";
import { hapkeReference } from "./hapke.ts";
import hapkeShader from "./shaders/hapke.wgsl?raw";
import sunlightShader from "./shaders/terrain-sunlight.wgsl?raw";
import solarVisibilityShader from "./shaders/solar-visibility.wgsl?raw";
import shadowHeightShader from "./shaders/shadow-height.wgsl?raw";
import { HEIGHT_STRIDE } from "../elevation/tiles.ts";
import type { HeightTileCache } from "../elevation/tile-cache.ts";
import heightLayerShader from "./shaders/sample-height-layer.wgsl?raw";
import surfaceHeightShader from "./shaders/sample-surface-height.wgsl?raw";
import surfaceNormalShader from "./shaders/surface-normal.wgsl?raw";
import type { HeightField } from "../elevation/height-field.ts";
import { createElevationTexture } from "./elevation-texture.ts";
import sampleElevationShader from "./shaders/sample-elevation.wgsl?raw";
import { IMAGERY_STRIDE, type ImageryCache } from "../imagery/tile-cache.ts";
import { createCheckerboardTexture } from "./checkerboard-texture.ts";
import { createTileGrid } from "./tile-grid.ts";
import * as THREE from "three/webgpu";
import {
  mix,
  vec3,
  vec4,
  positionView,
  cameraWorldMatrix,
  attribute,
  varying,
  uniform,
  positionLocal,
  wgslFn,
  texture,
  uv,
  dFdx,
  dFdy,
  max,
  sampler,
  positionWorld,
  float,
} from "three/tsl";
import vertexShader from "./shaders/vertex.wgsl?raw";
import tileToFaceUVShader from "./shaders/tile-to-face-uv.wgsl?raw";
import directionShader from "./shaders/face-uv-to-direction.wgsl?raw";
import positionToLatLonShader from "./shaders/position-to-lat-lon.wgsl?raw";
import latLonToUVShader from "./shaders/lat-lon-to-uv.wgsl?raw";
import longitudeGradientShader from "./shaders/longitude-uv-gradient.wgsl?raw";
import fragmentShader from "./shaders/fragment.wgsl?raw";
import surfaceDetailShader from "./shaders/surface-detail.wgsl?raw";
import nightLightsShader from "./shaders/night-lights.wgsl?raw";
import terrainNormalShader from "./shaders/terrain-normal.wgsl?raw";
import { defaultSunDirection } from "./sun.ts";
import { assertTileInstances, type TileInstances } from "./tile-instances.ts";

// One grid and material draw every selected tile as an instance. The CPU still
// selects and packs tiles; this layer borrows the arrays and owns GPU resources.
export function createTileLayer(
  radiusMeters: number,
  segments: number,
  instances: TileInstances,
  overviewTexture?: THREE.Texture,
  tiledImagery?: ImageryCache,
  elevation?: HeightField,
  cacheOptions: false | TerrainCacheOptions = {},
  lighting?: TerrainLighting,
  nightLights?: THREE.Texture,
  surfaceDetail = false,
) {
  assertTileInstances(instances);
  const capacity = instances.capacity;
  const cacheSettings = terrainCacheSettings(cacheOptions);
  let compute: TerrainCompute | undefined;
  const group = new THREE.Group();
  group.name = "Globe terrain";
  const gridTemplate = createTileGrid(segments);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setIndex(gridTemplate.index);
  for (const [name, buffer] of Object.entries(gridTemplate.attributes)) {
    geometry.setAttribute(name, buffer);
  }
  // The attributes now belong to the instanced geometry; this temporary wrapper
  // is never uploaded. No per-tile copies of the grid are created.
  gridTemplate.dispose();

  function instanceAttribute(name: string, array: Float32Array, components: number) {
    const buffer = new THREE.InstancedBufferAttribute(array, components);
    buffer.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(name, buffer);
    return buffer;
  }

  // Row i across these arrays describes tile i. InstancedBufferAttribute makes
  // the GPU advance to the next row per INSTANCE, not per grid vertex.
  const sizes = instanceAttribute("tileSize", instances.sizes, 2);
  const rotations = instanceAttribute("tileRotation", instances.rotations, 2);
  const centers = instanceAttribute("tileCenter", instances.centers, 3);
  const anchors = instanceAttribute("tileAnchor", instances.anchors, 3);
  const faceUVs = instanceAttribute("tileFaceUV", instances.faceUVs, 4);
  // Image and height records share ONE vertex-buffer binding.
  const imageBuffer = new THREE.InstancedInterleavedBuffer(
    new Float32Array(capacity * RENDER_BINDING_STRIDE),
    RENDER_BINDING_STRIDE,
  );
  imageBuffer.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("imageryLayers", new THREE.InterleavedBufferAttribute(imageBuffer, 2, 0));
  geometry.setAttribute("imageryUV", new THREE.InterleavedBufferAttribute(imageBuffer, 4, 2));
  geometry.setAttribute("parentImageryUV", new THREE.InterleavedBufferAttribute(imageBuffer, 4, 6));
  geometry.setAttribute("imageryBlend", new THREE.InterleavedBufferAttribute(imageBuffer, 1, 10));
  geometry.setAttribute(
    "heightLayers",
    new THREE.InterleavedBufferAttribute(imageBuffer, 2, IMAGERY_STRIDE),
  );
  geometry.setAttribute(
    "heightUV",
    new THREE.InterleavedBufferAttribute(imageBuffer, 4, IMAGERY_STRIDE + 2),
  );
  geometry.setAttribute(
    "parentHeightUV",
    new THREE.InterleavedBufferAttribute(imageBuffer, 4, IMAGERY_STRIDE + 6),
  );
  geometry.setAttribute(
    "heightBlendFace",
    new THREE.InterleavedBufferAttribute(imageBuffer, 4, IMAGERY_STRIDE + 10),
  );
  const colors = instanceAttribute("tileColor", instances.colors, 3);
  geometry.instanceCount = 0;
  // CPU culling cannot infer how WGSL expands the grid onto the body surface.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radiusMeters);

  const material = new THREE.MeshBasicNodeMaterial();
  material.name = "Instanced globe tiles";
  // Transform local grid UVs in the vertex stage, then interpolate face UVs.
  // Parent and child tiles sample the same image at the same face location.
  const tileToFaceUV = wgslFn(tileToFaceUVShader);
  const localToFace = tileToFaceUV({
    localUV: uv(),
    tileUV: attribute("tileFaceUV", "vec4"),
  }) as THREE.Node<"vec2">;
  const faceUV = varying(localToFace);
  const directionFunction = wgslFn(directionShader);
  const localDirection = directionFunction({
    faceUV: localToFace,
    rotation: attribute("tileRotation", "vec2"),
  }) as THREE.Node<"vec3">;
  const cubeDirection = varying(localDirection);
  let elevationTexture = createElevationTexture(elevation);
  const elevationNode = texture(elevationTexture);
  const elevationEnabled = uniform(elevation ? 1 : 0);
  const elevationRange = uniform(elevation ? elevation.maxMeters - elevation.minMeters : 0);
  const radius = uniform(radiusMeters);
  const shadingEnabled = uniform(1);
  const hapkeEnabled = uniform(1);
  const hapkePreset = [0.23, -0.3, 1.0, 0.05] as const;
  const hapkeParameters = uniform(new THREE.Vector4(...hapkePreset));
  const hapkeNormalization = uniform(hapkeReference(hapkePreset));
  const shadowsEnabled = uniform(1);
  const shadowSteps = uniform(24);
  const segmentCount = uniform(segments);
  const neutralTerrain = uniform(0);
  const maximumHeight = uniform(elevation?.maxMeters ?? 0);
  const minimumHeight = uniform(elevation?.minMeters ?? 0);
  const legacySampleSpacing = uniform(
    elevation ? (Math.PI * radiusMeters) / elevation.height : 2000,
  );
  const heightCoreSize = uniform(1);
  const heightGutter = uniform(0);
  const heightMaxLevel = uniform(0);
  const emptyShadowIndex = new THREE.DataTexture(
    new Float32Array(8).fill(-1),
    2,
    1,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  emptyShadowIndex.needsUpdate = true;
  const shadowIndexNode = texture(emptyShadowIndex);
  const sun = uniform(new THREE.Vector3(...defaultSunDirection()));
  let heightCache: HeightTileCache | undefined;
  const tiledHeights = uniform(0);
  const heightArray = new THREE.DataArrayTexture(new Uint8Array([32, 78, 0, 255]), 1, 1, 1);
  heightArray.needsUpdate = true;
  const heightArrayNode = texture(heightArray);
  const sampleHeightLayer = wgslFn(heightLayerShader);
  const sampleElevation = wgslFn(sampleElevationShader);
  // wgslFn returns a callable node proxy; the type declarations omit its CodeNode interface.
  const include = (fn: ReturnType<typeof wgslFn>) => fn as unknown as THREE.CodeNode;
  const sampleSurfaceHeight = wgslFn(surfaceHeightShader, [
    include(sampleElevation),
    include(sampleHeightLayer),
  ]);
  const heightRecord = attribute("heightBlendFace", "vec4");
  const fragmentHeightRecord = varying(heightRecord);
  const placeholderGradients = new THREE.StorageArrayTexture(1, 1, 1);
  placeholderGradients.type = THREE.HalfFloatType;
  placeholderGradients.generateMipmaps = false;
  const gradientNode = texture(placeholderGradients);
  const placeholderSunlight = new THREE.StorageTexture(1, 1);
  placeholderSunlight.format = THREE.RedFormat;
  placeholderSunlight.type = THREE.FloatType;
  placeholderSunlight.minFilter = placeholderSunlight.magFilter = THREE.NearestFilter;
  placeholderSunlight.generateMipmaps = false;
  const sunlightCacheNode = texture(placeholderSunlight);
  const sunlightColumns = uniform(1);
  const heightParameters = {
    heightMap: elevationNode,
    heightTiles: heightArrayNode,
    layers: attribute("heightLayers", "vec2"),
    bestUV: attribute("heightUV", "vec4"),
    parentUV: attribute("parentHeightUV", "vec4"),
    transition: heightRecord.x,
    tiled: tiledHeights,
  };
  const heightMeters = sampleSurfaceHeight({
    ...heightParameters,
    localUV: uv(),
    direction: localDirection,
    enabled: elevationEnabled,
  }) as THREE.Node<"float">;
  material.positionNode = wgslFn(vertexShader)({
    position: positionLocal,
    heightMeters,
    heightRange: mix(elevationRange, heightRecord.z, tiledHeights).mul(elevationEnabled),
    radius,
    tileSize: attribute("tileSize", "vec2"),
    tileRotation: attribute("tileRotation", "vec2"),
    segments: segmentCount,
    tileAnchor: attribute("tileAnchor", "vec3"),
    tileCenter: attribute("tileCenter", "vec3"),
  });
  const latLon = wgslFn(positionToLatLonShader)({ position: cubeDirection }) as THREE.Node<"vec2">;
  const overviewUV = wgslFn(latLonToUVShader)({
    latitude: latLon.x,
    longitude: latLon.y,
  }) as THREE.Node<"vec2">;
  const gradient = wgslFn(longitudeGradientShader);
  const imageryEnabled = uniform(overviewTexture || tiledImagery ? 1 : 0);
  const tiledImageryEnabled = uniform(tiledImagery ? 1 : 0);
  const emptyArray = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1);
  emptyArray.needsUpdate = true;
  const imageryArray = tiledImagery?.texture ?? emptyArray;
  const layers = varying(attribute("imageryLayers", "vec2"));
  const imageUV = varying(
    tileToFaceUV({
      localUV: uv(),
      tileUV: attribute("imageryUV", "vec4"),
    }) as THREE.Node<"vec2">,
  );
  const parentUV = varying(
    tileToFaceUV({
      localUV: uv(),
      tileUV: attribute("parentImageryUV", "vec4"),
    }) as THREE.Node<"vec2">,
  );
  const checkerboard = createCheckerboardTexture();
  const shadowHeight = wgslFn(shadowHeightShader, [
    include(sampleElevation),
    include(sampleHeightLayer),
  ]);
  const solarVisibility = wgslFn(solarVisibilityShader);
  // One interpolated float. A per-pixel march needs more varyings than WebGPU allows (16).
  const terrainSunlight = wgslFn(sunlightShader, [include(shadowHeight), include(solarVisibility)]);
  const sunlight = varying(
    wgslFn(cachedSunlightShader, [include(terrainSunlight)])({
      cache: sunlightCacheNode,
      cacheFlags: heightRecord.w,
      localUV: uv(),
      segments: segmentCount,
      columns: sunlightColumns,
      heightMap: elevationNode,
      heightTiles: heightArrayNode,
      indexMap: shadowIndexNode,
      direction: localDirection,
      heightMeters,
      sun,
      radius,
      minHeight: minimumHeight.mul(elevationEnabled),
      tiled: tiledHeights,
      coreSize: heightCoreSize,
      gutter: heightGutter,
      maxLevel: heightMaxLevel,
      maxHeight: maximumHeight,
      sampleSpacing: mix(
        legacySampleSpacing,
        radius
          .mul(2)
          .div(
            heightParameters.bestUV.z
              .abs()
              .mul(heightCoreSize.add(heightGutter.mul(2)))
              .max(0.000001),
          )
          .mul(attribute("tileFaceUV", "vec4").z),
        tiledHeights,
      ),
      // Geocentric angle of one mesh cell at a cube-face center (face UV * 2 / segments).
      cellRadians: attribute("tileFaceUV", "vec4").z.mul(2).div(segmentCount),
      enabled: shadowsEnabled.mul(elevationEnabled).mul(shadingEnabled).mul(imageryEnabled),
      steps: shadowSteps,
    }) as THREE.Node<"float">,
  );
  const normalFromGradient = wgslFn(normalGradientShader);
  const terrainNormal = wgslFn(cachedNormalShader, [
    include(
      wgslFn(surfaceNormalShader, [
        include(wgslFn(terrainNormalShader, [include(sampleElevation)])),
        include(sampleSurfaceHeight),
        include(normalFromGradient),
      ]),
    ),
    include(normalFromGradient),
  ])({
    gradients: gradientNode,
    gradientSampler: sampler(gradientNode),
    cacheFlags: fragmentHeightRecord.w,
    heightMap: elevationNode,
    heightTiles: heightArrayNode,
    tiled: tiledHeights,
    layers: varying(heightParameters.layers),
    bestUV: varying(heightParameters.bestUV),
    parentUV: varying(heightParameters.parentUV),
    transition: fragmentHeightRecord.x,
    localUV: uv(),
    face: fragmentHeightRecord.y,
    faceScale: varying(attribute("tileFaceUV", "vec4").zw),
    direction: cubeDirection,
    radius,
    enabled: elevationEnabled.mul(shadingEnabled).mul(imageryEnabled),
  }) as THREE.Node<"vec3">;
  const fragmentColor = wgslFn(fragmentShader, [
    include(wgslFn(hapkeShader)),
    include(solarVisibility),
    include(wgslFn(surfaceDetailShader)),
  ]);
  const detailEnabled = uniform(surfaceDetail ? 1 : 0);
  const texelsPerPixel = (sample: THREE.Node<"vec2">, width: number) =>
    surfaceDetail && width > 0
      ? max(dFdx(sample).length(), dFdy(sample).length()).mul(width)
      : float(2);
  const overviewWidth = (overviewTexture?.image as { width?: number } | undefined)?.width ?? 0;
  const imageryWidth = tiledImagery?.texture.image.width ?? 0;
  const fragmentInputs = {
    checkerColor: texture(checkerboard, faceUV).rgb,
    overviewColor: overviewTexture
      ? texture(overviewTexture, overviewUV).grad(
          gradient({ gradient: dFdx(overviewUV) }),
          gradient({ gradient: dFdy(overviewUV) }),
        ).rgb
      : vec3(0.35),
    imageryEnabled,
    tiledImageryEnabled,
    transition: varying(attribute("imageryBlend", "float")),
    tileColor: texture(imageryArray, imageUV).depth(layers.x),
    parentColor: texture(imageryArray, parentUV).depth(layers.y),
    faceColor: varying(attribute("tileColor", "vec3")),
    normal: terrainNormal,
    sun,
    sunlight,
    view: cameraWorldMatrix.mul(vec4(positionView.negate(), 0)).xyz,
    hapkeEnabled,
    hapkeParameters,
    hapkeReference: hapkeNormalization,
    neutralTerrain,
    shadingEnabled,
    radial: cubeDirection,
    radius,
    pixelMeters: surfaceDetail
      ? max(dFdx(cubeDirection).length(), dFdy(cubeDirection).length()).mul(radius)
      : float(1),
    detailEnabled,
    tileTexels: texelsPerPixel(imageUV, imageryWidth),
    parentTexels: texelsPerPixel(parentUV, imageryWidth),
    overviewTexels: texelsPerPixel(overviewUV, overviewWidth),
  };
  const color = fragmentColor(fragmentInputs) as THREE.Node<"vec3">;
  const day = lighting
    ? lighting({
        color: fragmentColor({ ...fragmentInputs, shadingEnabled: float(0) }) as THREE.Node<"vec3">,
        fallback: color,
        normal: terrainNormal,
        position: positionWorld,
        view: fragmentInputs.view,
        imageryEnabled: imageryEnabled.mul(neutralTerrain.oneMinus()),
        sunlight,
        enabled: shadingEnabled.mul(imageryEnabled),
      })
    : color;
  const nightEnabled = uniform(nightLights ? 1 : 0);
  const nightColor = nightLights
    ? texture(nightLights, overviewUV).grad(
        gradient({ gradient: dFdx(overviewUV) }),
        gradient({ gradient: dFdy(overviewUV) }),
      ).rgb
    : vec3(0);
  material.colorNode = nightLights
    ? (wgslFn(nightLightsShader)({
        day,
        lights: nightColor,
        radial: cubeDirection,
        sun,
        enabled: nightEnabled,
      }) as THREE.Node<"vec3">)
    : day;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "Instanced globe tiles";
  mesh.visible = false;
  // Positions are camera-relative; selection already performs visibility tests.
  mesh.frustumCulled = false;
  group.add(mesh);

  // Reuse the same attribute objects and GPU buffers. A Wasm memory growth may
  // require replacement typed-array views; pass the rebound descriptor here.
  function commit(next: TileInstances = instances): void {
    assertTileInstances(next);
    if (next.capacity !== capacity)
      throw new RangeError("Instance capacity cannot change after binding.");
    sizes.array = next.sizes;
    rotations.array = next.rotations;
    centers.array = next.centers;
    colors.array = next.colors;
    anchors.array = next.anchors;
    faceUVs.array = next.faceUVs;
    mesh.position.fromArray(next.origin);
    for (const buffer of [sizes, rotations, centers, colors, anchors, faceUVs]) {
      buffer.clearUpdateRanges();
      if (next.count > 0) {
        buffer.addUpdateRange(0, next.count * buffer.itemSize);
        buffer.needsUpdate = true;
      }
    }
    geometry.instanceCount = next.count;
    mesh.visible = next.count > 0;
    instances = next;
  }

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    compute?.dispose();
    placeholderGradients.dispose();
    placeholderSunlight.dispose();
    geometry.dispose();
    material.dispose();
    checkerboard.dispose();
    elevationTexture.dispose();
    emptyArray.dispose();
    heightArray.dispose();
    emptyShadowIndex.dispose();
    overviewTexture?.dispose();
    nightLights?.dispose();
    group.clear();
    group.removeFromParent();
  }

  function setWireframe(enabled: boolean): void {
    if (material.wireframe !== enabled) {
      material.wireframe = enabled;
      material.needsUpdate = true;
    }
  }

  function setImageryEnabled(enabled: boolean): void {
    imageryEnabled.value =
      enabled && (overviewTexture || tiledImagery || neutralTerrain.value > 0) ? 1 : 0;
  }
  function commitImagery(count: number): void {
    imageBuffer.clearUpdateRanges();
    if (count > 0) {
      const stride = RENDER_BINDING_STRIDE;
      for (let i = 0; i < count; i++) {
        if (tiledImagery)
          imageBuffer.array.set(
            tiledImagery.bindings.data.subarray(i * IMAGERY_STRIDE, (i + 1) * IMAGERY_STRIDE),
            i * stride,
          );
        if (heightCache)
          imageBuffer.array.set(
            heightCache.bindings.data.subarray(i * HEIGHT_STRIDE, (i + 1) * HEIGHT_STRIDE),
            i * stride + IMAGERY_STRIDE,
          );
      }
      for (let i = 0; i < count; i++)
        imageBuffer.array[i * stride + stride - 1] = compute?.flags[i] ?? 0;
      imageBuffer.addUpdateRange(0, count * stride);
      imageBuffer.needsUpdate = true;
    }
  }
  function setSurfaceLayer(layer: "overview" | "checker" | "imagery" | "terrain"): void {
    neutralTerrain.value = layer === "terrain" ? 1 : 0;
    nightEnabled.value = layer === "checker" || !nightLights ? 0 : 1;
    setImageryEnabled(layer !== "checker");
    tiledImageryEnabled.value = layer === "imagery" && tiledImagery ? 1 : 0;
  }
  function setElevation(field: HeightField): void {
    if (disposed) return;
    const previous = elevationTexture;
    elevationTexture = createElevationTexture(field);
    elevationNode.value = elevationTexture;
    elevation = field;
    maximumHeight.value = field.maxMeters;
    minimumHeight.value = field.minMeters;
    legacySampleSpacing.value = (Math.PI * radiusMeters) / field.height;
    elevationRange.value = field.maxMeters - field.minMeters;
    elevationEnabled.value = 1;
    material.needsUpdate = true;
    previous.dispose();
  }
  function setElevationEnabled(enabled: boolean): void {
    elevationEnabled.value = enabled && (elevation || heightCache) ? 1 : 0;
  }
  function setSun(x: number, y: number, z: number): void {
    sun.value.set(x, y, z).normalize();
  }
  return {
    setShadingEnabled(enabled: boolean) {
      shadingEnabled.value = enabled ? 1 : 0;
    },
    setHapkeEnabled(enabled: boolean) {
      hapkeEnabled.value = enabled ? 1 : 0;
    },
    setTerrainShadows(enabled: boolean) {
      shadowsEnabled.value = enabled ? 1 : 0;
    },
    setShadowSteps(steps: number) {
      shadowSteps.value = Math.min(48, Math.max(8, Math.round(steps)));
    },
    setHeightTiles(cache: HeightTileCache) {
      shadowIndexNode.value = cache.shadowIndex;
      heightCoreSize.value = cache.manifest.tileSize;
      heightGutter.value = cache.manifest.gutter;
      heightMaxLevel.value = cache.manifest.maxLevel;
      maximumHeight.value = cache.manifest.maxMeters;
      minimumHeight.value = cache.manifest.minMeters;
      compute?.dispose();
      heightCache = cache;
      heightArrayNode.value = cache.texture;
      tiledHeights.value = 1;
      elevationEnabled.value = 1;
      elevationRange.value = cache.manifest.maxMeters - cache.manifest.minMeters;
      {
        compute = createTerrainCompute(
          cache,
          segments,
          {
            heightMap: elevationNode,
            heightTiles: heightArrayNode,
            indexMap: shadowIndexNode,
            radius,
            sun,
            minHeight: minimumHeight,
            maxHeight: maximumHeight,
            coreSize: heightCoreSize,
            gutter: heightGutter,
            maxLevel: heightMaxLevel,
            steps: shadowSteps,
          },
          {
            direction: directionFunction,
            surfaceHeight: sampleSurfaceHeight,
            sunlight: terrainSunlight,
          },
          cacheSettings,
        );
        gradientNode.value = compute.gradients;
        sunlightCacheNode.value = compute.sunlight;
        sunlightColumns.value = compute.columns;
      }
      material.needsUpdate = true;
    },
    prepareCaches(
      renderer: THREE.WebGPURenderer,
      now: number,
      view: StreamingView,
      requestRender: () => void,
      report: (error: unknown) => void,
    ) {
      const active =
        elevationEnabled.value > 0 && shadingEnabled.value > 0 && imageryEnabled.value > 0;
      compute?.prepare(
        renderer,
        instances,
        now,
        [sun.value.x, sun.value.y, sun.value.z, shadowSteps.value].join("/"),
        active,
        active && shadowsEnabled.value > 0,
        view,
        requestRender,
        report,
      );
    },
    cacheStats: () => compute?.stats,
    setNormalCacheEnabled(enabled: boolean) {
      cacheSettings.normals = enabled;
      compute?.setNormals(enabled);
      material.needsUpdate = true;
    },
    setSunlightCacheEnabled(enabled: boolean) {
      cacheSettings.sunlight = enabled;
      compute?.setSunlight(enabled);
      material.needsUpdate = true;
    },
    setElevation,
    setElevationEnabled,
    setSun,
    group,
    commit,
    commitImagery,
    setWireframe,
    setSurfaceLayer,
    dispose,
  };
}
