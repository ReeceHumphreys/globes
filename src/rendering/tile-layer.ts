import { createTerrainCompute, type TerrainCompute } from "./terrain-compute.ts";
import { terrainCacheSettings, type TerrainCacheOptions } from "./terrain-cache-state.ts";
import {
  HEIGHT_RANGE,
  HEIGHT_STRIDE,
  IMAGERY_STRIDE,
  PAIR,
  ROW_FLAGS,
  ROW_HEIGHT,
  ROW_STRIDE,
} from "./binding-row.ts";
import type { StreamingView } from "../imagery/priority.ts";
import cachedNormalShader from "./shaders/cached-normal.wgsl?raw";
import normalGradientShader from "./shaders/normal-from-gradient.wgsl?raw";
import cachedSunlightShader from "./shaders/cached-sunlight.wgsl?raw";
import cacheFlagsShader from "./shaders/cache-flags.wgsl?raw";
import decodeHeightShader from "./shaders/decode-height.wgsl?raw";
import rootPointShader from "./shaders/root-point.wgsl?raw";
import rootJoinShader from "./shaders/root-join.wgsl?raw";
import rootTangentsShader from "./shaders/root-tangents.wgsl?raw";
import { hapkeReference } from "./hapke.ts";
import hapkeShader from "./shaders/hapke.wgsl?raw";
import sunlightShader from "./shaders/terrain-sunlight.wgsl?raw";
import solarVisibilityShader from "./shaders/solar-visibility.wgsl?raw";
import shadowHeightShader from "./shaders/shadow-height.wgsl?raw";
import { createHeightTileCache, type HeightTileCache } from "../elevation/tile-cache.ts";
import type { HeightSource } from "../elevation/source.ts";
import heightLayerShader from "./shaders/sample-height-layer.wgsl?raw";
import surfaceHeightShader from "./shaders/sample-surface-height.wgsl?raw";
import surfaceNormalShader from "./shaders/surface-normal.wgsl?raw";
import { createImageryCache } from "../imagery/tile-cache.ts";
import type { ImagerySource } from "../imagery/source.ts";
import { createCheckerboardTexture } from "./checkerboard-texture.ts";
import { createTileGrid } from "./tile-grid.ts";
import * as THREE from "three/webgpu";
import {
  vec3,
  vec4,
  positionView,
  cameraWorldMatrix,
  modelWorldMatrixInverse,
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
  float,
  mix,
  vec2,
  screenCoordinate,
  abs,
  bool,
} from "three/tsl";
import { gridShader } from "../tiles/roots.ts";
import vertexShader from "./shaders/vertex.wgsl?raw";
import ellipsoidOffsetShader from "./shaders/ellipsoid-offset.wgsl?raw";
import tileToRootUVShader from "./shaders/tile-to-root-uv.wgsl?raw";
import directionShader from "./shaders/root-direction.wgsl?raw";
import positionToLatLonShader from "./shaders/position-to-lat-lon.wgsl?raw";
import latLonToUVShader from "./shaders/lat-lon-to-uv.wgsl?raw";
import longitudeGradientShader from "./shaders/longitude-uv-gradient.wgsl?raw";
import fragmentShader from "./shaders/fragment.wgsl?raw";
import transmittanceShader from "./shaders/atmosphere-transmittance.wgsl?raw";
import oceanShader from "./shaders/ocean.wgsl?raw";
import type { AtmosphereLight } from "../atmosphere/atmosphere.ts";
import type { SurfaceOverlay, SurfacePoint } from "../overlay.ts";
import { MAX_TERRAIN_MASKS, type TerrainMask } from "../terrain-mask.ts";
import { SKY_LIGHT_WIDTH } from "../atmosphere/model.ts";
import surfaceDetailShader from "./shaders/surface-detail.wgsl?raw";
import nightLightsShader from "./shaders/night-lights.wgsl?raw";
import cloudCoverShader from "./shaders/cloud-cover.wgsl?raw";
import cloudShadowShader from "./shaders/cloud-shadow.wgsl?raw";
import skyLightUShader from "./shaders/sky-light-u.wgsl?raw";
import { onePixel } from "./one-pixel.ts";
import { geographicToDirection } from "../geographic.ts";
import { ellipsoidOffset } from "../ellipsoid.ts";
import { assertTileInstances, type TileInstances } from "./tile-instances.ts";

// One grid and material draw every selected tile as an instance. The CPU still
// selects and packs tiles; this layer borrows the arrays and owns GPU resources.
/** What the terrain shows: tiled imagery, the overview image, neutral terrain, or a checker. */
export type SurfaceLayer = "imagery" | "overview" | "terrain" | "checker";

/** Runtime display settings for the tile layer. */
export interface TerrainSettings {
  layer: SurfaceLayer;
  shading: boolean;
  shadows: boolean;
  /** Shadow ray-march steps, clamped to 8..48. */
  shadowSteps: number;
  hapke: boolean;
  /** Light everywhere, on top of the sun: 1 is as bright as the noon sun. */
  ambient: number;
  wireframe: boolean;
  /** Displace by height tiles; stays off until they are set. */
  elevation: boolean;
}

export interface TileLayerOptions {
  radiusMeters: number;
  /** Grid cells along each tile edge. */
  segments: number;
  /** Initial instances; their capacity is fixed for the layer's lifetime. */
  instances: TileInstances;
  /** Ownership transfers to the layer. */
  overview?: THREE.Texture;
  /** Tiled imagery. The layer streams it for as long as it lives. */
  imagery?: ImagerySource;
  /** Texture layers for resident imagery tiles. */
  imagerySlots?: number;
  caches?: TerrainCacheOptions;
  /** Ownership transfers to the layer. */
  nightLights?: THREE.Texture;
  /** Equirectangular water fraction in red. Ownership transfers to the layer. */
  waterMask?: THREE.Texture;
  surfaceDetail?: boolean;
  /** Polar flattening of the surface; 0 is a sphere. */
  flattening?: number;
  /** A cache needs another frame. */
  requestRender(): void;
  /** Background GPU work failed. */
  report(error: unknown): void;
}

/** Everything that changes between frames. */
export interface TerrainFrame {
  renderer: THREE.WebGPURenderer;
  instances: TileInstances;
  view: StreamingView;
  /** Toward the sun, in the globe's frame. */
  sun: THREE.Vector3;
  /** Camera height above the ellipsoid. */
  altitude: number;
  overlays: readonly SurfaceOverlay[];
  /** Placed masks; only the first {@link MAX_TERRAIN_MASKS} count. */
  masks: readonly TerrainMask[];
  /** Camera position in the globe's frame. */
  camera: THREE.Vector3;
  light: AtmosphereLight | null;
}

export function createTileLayer({
  radiusMeters,
  segments,
  instances,
  overview: overviewTexture,
  imagery: imagerySource,
  imagerySlots = 255,
  caches: cacheOptions = {},
  nightLights,
  waterMask,
  surfaceDetail = false,
  flattening = 0,
  requestRender,
  report,
}: TileLayerOptions) {
  assertTileInstances(instances);
  const capacity = instances.capacity;
  const tiledImagery =
    imagerySource &&
    createImageryCache(imagerySource, capacity, requestRender, imagerySlots, { onError: report });
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
  const sizes = instanceAttribute("tileSize", instances.sizes, 1);
  const roots = instanceAttribute("tileRoot", instances.roots, 1);
  const anchors = instanceAttribute("tileAnchor", instances.anchors, 3);
  const rootUVs = instanceAttribute("tileRootUV", instances.rootUVs, 3);
  // Image and height records share ONE vertex-buffer binding.
  const imageBuffer = new THREE.InstancedInterleavedBuffer(
    new Float32Array(capacity * ROW_STRIDE),
    ROW_STRIDE,
  );
  imageBuffer.setUsage(THREE.DynamicDrawUsage);
  const rowAttribute = (name: string, size: number, offset: number) =>
    geometry.setAttribute(name, new THREE.InterleavedBufferAttribute(imageBuffer, size, offset));
  rowAttribute("imageryLayers", 2, PAIR.layers);
  rowAttribute("imageryUV", 4, PAIR.best);
  rowAttribute("parentImageryUV", 4, PAIR.parent);
  rowAttribute("imageryBlend", 1, PAIR.blend);
  rowAttribute("heightLayers", 2, ROW_HEIGHT + PAIR.layers);
  rowAttribute("heightUV", 4, ROW_HEIGHT + PAIR.best);
  rowAttribute("parentHeightUV", 4, ROW_HEIGHT + PAIR.parent);
  // Blend, root, height range, cache flags: four neighbours read as one vec4.
  if (HEIGHT_RANGE !== PAIR.blend + 1 || ROW_FLAGS !== ROW_HEIGHT + HEIGHT_STRIDE)
    throw new Error("heightBlend no longer matches the binding row");
  rowAttribute("heightBlend", 3, ROW_HEIGHT + PAIR.blend);
  const colors = instanceAttribute("tileColor", instances.colors, 3);
  geometry.instanceCount = 0;
  // CPU culling cannot infer how WGSL expands the grid onto the body surface.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radiusMeters);

  const material = new THREE.MeshBasicNodeMaterial();
  material.name = "Instanced globe tiles";
  // Transform local grid UVs in the vertex stage, then interpolate root UVs.
  // Parent and child tiles sample the same image at the same root location.
  const tileToRootUV = wgslFn(tileToRootUVShader);
  const rootTile = attribute("tileRootUV", "vec3");
  const localToRoot = tileToRootUV({
    localUV: uv(),
    tileUV: vec4(rootTile.xy, rootTile.z, rootTile.z),
  }) as THREE.Node<"vec2">;
  const rootUV = varying(localToRoot);
  const directionFunction = wgslFn(gridShader(directionShader));
  const tileRoot = attribute("tileRoot", "float");
  // One varying for every fragment use: the pipeline is at the limit of 16.
  const fragmentRoot = varying(tileRoot);
  const localDirection = directionFunction({
    root: tileRoot,
    uv: localToRoot,
  }) as THREE.Node<"vec3">;
  const surfaceDirection = varying(localDirection);
  const elevationEnabled = uniform(0);
  const radius = uniform(radiusMeters);
  const shadingEnabled = uniform(1);
  const hapkeEnabled = uniform(1);
  const ambient = uniform(0);
  const hapkePreset = [0.23, -0.3, 1.0, 0.05] as const;
  const hapkeParameters = uniform(new THREE.Vector4(...hapkePreset));
  const hapkeNormalization = uniform(hapkeReference(hapkePreset));
  const shadowsEnabled = uniform(1);
  const shadowSteps = uniform(24);
  const segmentCount = uniform(segments);
  const neutralTerrain = uniform(0);
  const maximumHeight = uniform(0);
  const minimumHeight = uniform(0);
  const heightCoreSize = uniform(1);
  const heightGutter = uniform(0);
  const heightMaxLevel = uniform(0);
  const heightEncoding = uniform(new THREE.Vector2(1, 0));
  const emptyShadowIndex = new THREE.DataTexture(
    new Float32Array(8).fill(-1),
    2,
    1,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  emptyShadowIndex.needsUpdate = true;
  const shadowIndexNode = texture(emptyShadowIndex);
  const sun = uniform(geographicToDirection(0, 90));
  // Ground light from an Atmosphere child: always compiled, so adding or removing one
  // never recompiles the terrain. Placeholders keep it white and dark until then.
  const atmosphereEnabled = uniform(0);
  const atmosphereBottom = uniform(1),
    atmosphereTop = uniform(2),
    atmosphereIntensity = uniform(1);
  const groundSunCosine = surfaceDirection.normalize().dot(sun.normalize());
  const skyLightU = wgslFn(skyLightUShader)({
    mu: groundSunCosine,
    width: float(SKY_LIGHT_WIDTH),
  }) as THREE.Node<"float">;
  const emptyTransmittance = onePixel(255),
    emptySkyLight = onePixel(0);
  const transmittanceNode = texture(emptyTransmittance),
    skyLightNode = texture(emptySkyLight, vec2(skyLightU, 0.5));
  let heightCache: HeightTileCache | undefined;
  const heightArray = new THREE.DataArrayTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, 1);
  heightArray.needsUpdate = true;
  const heightArrayNode = texture(heightArray);
  // wgslFn returns a callable node proxy; the type declarations omit its CodeNode interface.
  const include = (fn: ReturnType<typeof wgslFn>) => fn as unknown as THREE.CodeNode;
  const sampleHeightLayer = wgslFn(heightLayerShader, [include(wgslFn(decodeHeightShader))]);
  const cacheFlags = wgslFn(cacheFlagsShader);
  const sampleSurfaceHeight = wgslFn(surfaceHeightShader, [include(sampleHeightLayer)]);
  const heightRecord = attribute("heightBlend", "vec3");
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
    heightTiles: heightArrayNode,
    layers: attribute("heightLayers", "vec2"),
    bestUV: attribute("heightUV", "vec4"),
    parentUV: attribute("parentHeightUV", "vec4"),
    transition: heightRecord.x,
    encoding: heightEncoding,
  };
  const heightMeters = sampleSurfaceHeight({
    ...heightParameters,
    localUV: uv(),
    direction: localDirection,
    enabled: elevationEnabled,
  }) as THREE.Node<"float">;
  const cameraOffset = uniform(new THREE.Vector3());
  material.positionNode = wgslFn(gridShader(vertexShader), [
    include(wgslFn(ellipsoidOffsetShader)),
    include(directionFunction),
  ])({
    position: positionLocal,
    heightMeters,
    heightRange: heightRecord.y.mul(elevationEnabled),
    radius,
    tileSize: attribute("tileSize", "float"),
    tileRoot,
    tileUV: localToRoot,
    segments: segmentCount,
    tileAnchor: attribute("tileAnchor", "vec3"),
    tile: rootTile,
    e2: float(flattening * (2 - flattening)),
    cameraOffset,
  });
  const positionToLatLon = wgslFn(positionToLatLonShader);
  const latLonToUV = wgslFn(latLonToUVShader);
  const latLon = positionToLatLon({ position: surfaceDirection }) as THREE.Node<"vec2">;
  const overviewUV = latLonToUV({
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
    tileToRootUV({
      localUV: uv(),
      tileUV: attribute("imageryUV", "vec4"),
    }) as THREE.Node<"vec2">,
  );
  const parentUV = varying(
    tileToRootUV({
      localUV: uv(),
      tileUV: attribute("parentImageryUV", "vec4"),
    }) as THREE.Node<"vec2">,
  );
  const checkerboard = createCheckerboardTexture();
  const shadowHeight = wgslFn(gridShader(shadowHeightShader), [
    include(sampleHeightLayer),
    include(wgslFn(gridShader(rootPointShader))),
  ]);
  const solarVisibility = wgslFn(solarVisibilityShader);
  // One interpolated float. A per-pixel march needs more varyings than WebGPU allows (16).
  const terrainSunlight = wgslFn(sunlightShader, [include(shadowHeight), include(solarVisibility)]);
  const sunlight = varying(
    wgslFn(cachedSunlightShader, [include(terrainSunlight), include(cacheFlags)])({
      cache: sunlightCacheNode,
      cacheFlags: heightRecord.z,
      localUV: uv(),
      segments: segmentCount,
      columns: sunlightColumns,
      heightTiles: heightArrayNode,
      indexMap: shadowIndexNode,
      direction: localDirection,
      heightMeters,
      sun,
      radius,
      minHeight: minimumHeight.mul(elevationEnabled),
      coreSize: heightCoreSize,
      gutter: heightGutter,
      maxLevel: heightMaxLevel,
      maxHeight: maximumHeight,
      sampleSpacing: attribute("tileSize", "float").div(
        heightParameters.bestUV.z
          .abs()
          .mul(heightCoreSize.add(heightGutter.mul(2)))
          .max(0.000001),
      ),
      // Geocentric angle of one mesh cell.
      cellRadians: attribute("tileSize", "float").div(radius).div(segmentCount),
      enabled: shadowsEnabled.mul(elevationEnabled).mul(shadingEnabled).mul(imageryEnabled),
      steps: shadowSteps,
      encoding: heightEncoding,
    }) as THREE.Node<"float">,
  );
  const normalFromGradient = wgslFn(normalGradientShader, [
    include(wgslFn(gridShader(rootTangentsShader))),
  ]);
  const terrainNormal = wgslFn(cachedNormalShader, [
    include(
      wgslFn(surfaceNormalShader, [include(sampleSurfaceHeight), include(normalFromGradient)]),
    ),
    include(normalFromGradient),
    include(cacheFlags),
  ])({
    gradients: gradientNode,
    gradientSampler: sampler(gradientNode),
    cacheFlags: fragmentHeightRecord.z,
    heightTiles: heightArrayNode,
    layers: varying(heightParameters.layers),
    bestUV: varying(heightParameters.bestUV),
    parentUV: varying(heightParameters.parentUV),
    transition: fragmentHeightRecord.x,
    localUV: uv(),
    root: fragmentRoot,
    rootScale: varying(rootTile.z),
    direction: surfaceDirection,
    radius,
    enabled: elevationEnabled.mul(shadingEnabled).mul(imageryEnabled),
    encoding: heightEncoding,
  }) as THREE.Node<"vec3">;
  const fragmentColor = wgslFn(fragmentShader, [
    include(wgslFn(hapkeShader)),
    include(solarVisibility),
    include(wgslFn(surfaceDetailShader)),
    include(wgslFn(oceanShader)),
  ]);
  const detailEnabled = uniform(surfaceDetail ? 1 : 0);
  const nightLight = uniform(new THREE.Vector3());
  const waterRoughness = uniform(ORBIT_WATER_ROUGHNESS);
  const emptyClouds = onePixel(0);
  const cloudNode = texture(emptyClouds);
  const cloudHeight = uniform(0);
  const cloudStrength = uniform(0);
  const texelsPerPixel = (sample: THREE.Node<"vec2">, width: number) =>
    surfaceDetail && width > 0
      ? max(dFdx(sample).length(), dFdy(sample).length()).mul(width)
      : float(2);
  const overviewWidth = (overviewTexture?.image as { width?: number } | undefined)?.width ?? 0;
  const imageryWidth = tiledImagery?.texture.image.width ?? 0;
  // Explicit gradients, so a texture sampled on the overview's UVs keeps its mips at the seam.
  const sampleOverview = (map: THREE.Texture) =>
    texture(map, overviewUV).grad(
      gradient({ gradient: dFdx(overviewUV) }),
      gradient({ gradient: dFdy(overviewUV) }),
    );
  const fragmentInputs = {
    checkerColor: texture(checkerboard, rootUV).rgb,
    overviewColor: overviewTexture ? sampleOverview(overviewTexture).rgb : vec3(0.35),
    imageryEnabled,
    tiledImageryEnabled,
    transition: varying(attribute("imageryBlend", "float")),
    tileColor: texture(imageryArray, imageUV).depth(layers.x),
    parentColor: texture(imageryArray, parentUV).depth(layers.y),
    rootColor: varying(attribute("tileColor", "vec3")),
    normal: terrainNormal,
    sun,
    sunlight: sunlight.mul(
      wgslFn(cloudShadowShader, [
        include(wgslFn(cloudCoverShader, [include(positionToLatLon), include(latLonToUV)])),
      ])({
        map: cloudNode,
        mapSampler: sampler(cloudNode),
        radial: surfaceDirection,
        sun,
        radius,
        height: cloudHeight,
        strength: cloudStrength,
      }) as THREE.Node<"float">,
    ),
    // Surface-to-camera in the globe's own frame, where the sun and normals live.
    view: modelWorldMatrixInverse.mul(cameraWorldMatrix.mul(vec4(positionView.negate(), 0))).xyz,
    hapkeEnabled,
    hapkeParameters,
    hapkeReference: hapkeNormalization,
    neutralTerrain,
    shadingEnabled,
    radial: surfaceDirection,
    radius,
    pixelMeters: max(dFdx(surfaceDirection).length(), dFdy(surfaceDirection).length()).mul(radius),
    detailEnabled,
    // Sunlight filtered by the air between the ground and the sun, and blue sky light.
    sunColor: mix(
      vec3(1),
      (
        wgslFn(transmittanceShader)({
          lut: transmittanceNode,
          lutSampler: sampler(transmittanceNode),
          bottom: atmosphereBottom,
          top: atmosphereTop,
          r: atmosphereBottom.add(1),
          mu: groundSunCosine,
        }) as THREE.Node<"vec3">
      ).mul(atmosphereIntensity),
      atmosphereEnabled,
    ),
    skyLight: skyLightNode.rgb
      .mul(atmosphereIntensity)
      .add(nightLight)
      .mul(atmosphereEnabled)
      .add(ambient),
    water: waterMask ? sampleOverview(waterMask).r : float(0),
    waterRoughness,
    tileTexels: texelsPerPixel(imageUV, imageryWidth),
    parentTexels: texelsPerPixel(parentUV, imageryWidth),
    overviewTexels: texelsPerPixel(overviewUV, overviewWidth),
  };
  const color = fragmentColor(fragmentInputs) as THREE.Node<"vec3">;
  const day = color;
  const nightEnabled = uniform(nightLights ? 1 : 0);
  const nightColor = nightLights
    ? sampleOverview(nightLights)
        // A coarse mip is the warm glow of city light in the air around it.
        .rgb.add(
          // The floor skips the moonlit land in the photo, which would otherwise glow too.
          max(texture(nightLights, overviewUV).level(float(5)).rgb.sub(0.14), 0).mul(
            vec3(0.9, 0.65, 0.4),
          ),
        )
    : vec3(0);
  material.colorNode = nightLights
    ? (wgslFn(nightLightsShader)({
        day,
        lights: nightColor,
        radial: surfaceDirection,
        sun,
        enabled: nightEnabled,
      }) as THREE.Node<"vec3">)
    : day;
  const surfaceColor = material.colorNode as THREE.Node<"vec3">;
  // Terrain masks: each a rectangle around a center held relative to the camera, so it
  // stays exact up close. A zero half-size disables a slot.
  const maskSlots = Array.from({ length: MAX_TERRAIN_MASKS }, () => ({
    center: uniform(new THREE.Vector3()),
    across: uniform(new THREE.Vector3(1, 0, 0)),
    along: uniform(new THREE.Vector3(0, 0, 1)),
    half: uniform(new THREE.Vector2()),
  }));
  // Fragment minus camera, in the globe's frame.
  const fromCamera = modelWorldMatrixInverse.mul(cameraWorldMatrix.mul(vec4(positionView, 0))).xyz;
  const masked = maskSlots.reduce((hidden: THREE.Node<"bool">, slot) => {
    const d = fromCamera.sub(slot.center);
    return hidden.or(
      abs(d.dot(slot.across))
        .lessThan(slot.half.x)
        .and(abs(d.dot(slot.along)).lessThan(slot.half.y)),
    ) as THREE.Node<"bool">;
  }, bool(false));
  material.maskNode = (
    wgslFn(gridShader(rootJoinShader))({
      direction: surfaceDirection,
      root: fragmentRoot,
      pixel: screenCoordinate,
    }) as THREE.Node<"float">
  )
    .greaterThan(0.5)
    .and(masked.not());
  function setMasks(masks: readonly TerrainMask[], camera: THREE.Vector3): void {
    maskSlots.forEach((slot, i) => {
      const mask = masks[i];
      if (!mask) return slot.half.value.set(0, 0);
      slot.center.value.copy(mask.position).sub(camera);
      mask.axes(slot.across.value, slot.along.value);
      slot.half.value.set(mask.width / 2, mask.length / 2);
    });
  }
  const surfacePoint: SurfacePoint = {
    uv: overviewUV,
    uvDx: gradient({ gradient: dFdx(overviewUV) }) as THREE.Node<"vec2">,
    uvDy: gradient({ gradient: dFdy(overviewUV) }) as THREE.Node<"vec2">,
    latitude: latLon.x,
    longitude: latLon.y,
    normal: surfaceDirection,
    pixelMeters: fragmentInputs.pixelMeters,
  };
  let overlays: readonly SurfaceOverlay[] = [];
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "Instanced globe tiles";
  mesh.visible = false;
  // Positions are camera-relative; selection already performs visibility tests.
  mesh.frustumCulled = false;
  group.add(mesh);

  let committedRevision = -1;
  function commit(next: TileInstances): void {
    if (next === instances && next.revision === committedRevision) return;
    assertTileInstances(next);
    if (next.capacity !== capacity)
      throw new RangeError("Instance capacity cannot change after binding.");
    sizes.array = next.sizes;
    roots.array = next.roots;
    colors.array = next.colors;
    anchors.array = next.anchors;
    rootUVs.array = next.rootUVs;
    // The origin is the camera's sphere point; the camera is off it by the same offset.
    ellipsoidOffset(
      _normal.fromArray(next.origin).normalize(),
      radiusMeters,
      flattening,
      cameraOffset.value,
    );
    mesh.position.fromArray(next.origin).add(cameraOffset.value);
    for (const buffer of [sizes, roots, colors, anchors, rootUVs]) {
      buffer.clearUpdateRanges();
      if (next.count > 0) {
        buffer.addUpdateRange(0, next.count * buffer.itemSize);
        buffer.needsUpdate = true;
      }
    }
    geometry.instanceCount = next.count;
    mesh.visible = next.count > 0;
    instances = next;
    committedRevision = next.revision;
  }

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    compute?.dispose();
    tiledImagery?.dispose();
    heightCache?.dispose();
    placeholderGradients.dispose();
    placeholderSunlight.dispose();
    geometry.dispose();
    material.dispose();
    checkerboard.dispose();
    emptyArray.dispose();
    heightArray.dispose();
    emptyShadowIndex.dispose();
    emptyClouds.dispose();
    emptyTransmittance.dispose();
    emptySkyLight.dispose();
    overviewTexture?.dispose();
    nightLights?.dispose();
    waterMask?.dispose();
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
  function commitRows(count: number): void {
    imageBuffer.clearUpdateRanges();
    if (count > 0) {
      const stride = ROW_STRIDE;
      for (let i = 0; i < count; i++) {
        if (tiledImagery)
          imageBuffer.array.set(
            tiledImagery.bindings.data.subarray(i * IMAGERY_STRIDE, (i + 1) * IMAGERY_STRIDE),
            i * stride,
          );
        if (heightCache)
          imageBuffer.array.set(
            heightCache.bindings.data.subarray(i * HEIGHT_STRIDE, (i + 1) * HEIGHT_STRIDE),
            i * stride + ROW_HEIGHT,
          );
      }
      for (let i = 0; i < count; i++)
        imageBuffer.array[i * stride + ROW_FLAGS] = compute?.flags[i] ?? 0;
      imageBuffer.addUpdateRange(0, count * stride);
      imageBuffer.needsUpdate = true;
    }
  }
  function setSurfaceLayer(layer: SurfaceLayer): void {
    neutralTerrain.value = layer === "terrain" ? 1 : 0;
    nightEnabled.value = layer === "checker" || !nightLights ? 0 : 1;
    setImageryEnabled(layer !== "checker");
    tiledImageryEnabled.value = layer === "imagery" && tiledImagery ? 1 : 0;
  }
  /** Apply any subset of the terrain settings. Elevation stays off until height tiles are set. */
  function set(next: Partial<TerrainSettings>): void {
    if (next.layer !== undefined) setSurfaceLayer(next.layer);
    if (next.shading !== undefined) shadingEnabled.value = next.shading ? 1 : 0;
    if (next.hapke !== undefined) hapkeEnabled.value = next.hapke ? 1 : 0;
    if (next.ambient !== undefined) ambient.value = next.ambient;
    if (next.shadows !== undefined) shadowsEnabled.value = next.shadows ? 1 : 0;
    if (next.shadowSteps !== undefined)
      shadowSteps.value = Math.min(48, Math.max(8, Math.round(next.shadowSteps)));
    if (next.wireframe !== undefined) setWireframe(next.wireframe);
    if (next.elevation !== undefined)
      elevationEnabled.value = next.elevation && heightCache ? 1 : 0;
  }
  function setLight(light: AtmosphereLight | null): void {
    atmosphereEnabled.value = light ? 1 : 0;
    transmittanceNode.value = light?.transmittance ?? emptyTransmittance;
    skyLightNode.value = light?.skyLight ?? emptySkyLight;
    cloudNode.value = light?.cloudMap ?? emptyClouds;
    cloudHeight.value = light?.cloudAltitude ?? 0;
    // The sky draws the clouds, so without one there is nothing to cast their shadow.
    cloudStrength.value = light?.cloudStrength ?? 0;
    if (!light) return;
    atmosphereBottom.value = light.bottom;
    atmosphereTop.value = light.top;
    atmosphereIntensity.value = light.intensity;
    nightLight.value.fromArray(light.nightLight);
  }
  // Recompiles the material only if the list changed.
  function setOverlays(next: readonly SurfaceOverlay[]): void {
    if (next.length === overlays.length && next.every((overlay, i) => overlay === overlays[i]))
      return;
    overlays = next;
    material.colorNode = next.reduce(
      (color, overlay) => overlay.over(color, surfacePoint),
      surfaceColor,
    );
    material.needsUpdate = true;
  }
  function prepareCaches(renderer: THREE.WebGPURenderer, view: StreamingView): void {
    const active =
      elevationEnabled.value > 0 && shadingEnabled.value > 0 && imageryEnabled.value > 0;
    compute?.prepare({
      renderer,
      instances,
      now: view.now,
      epoch: [sun.value.x, sun.value.y, sun.value.z, shadowSteps.value].join("/"),
      activeNormals: active,
      activeSunlight: active && shadowsEnabled.value > 0,
      view,
      requestRender,
      report,
    });
  }
  /** Draw this frame: light and overlays, then the tiles, their streaming and their caches. */
  function update(frame: TerrainFrame): void {
    sun.value.copy(frame.sun).normalize();
    setLight(frame.light);
    setOverlays(frame.overlays);
    setMasks(frame.masks, frame.camera);
    // Waves too small to see from orbit read as roughness; closer in, they are drawn.
    waterRoughness.value = THREE.MathUtils.lerp(
      CLOSE_WATER_ROUGHNESS,
      ORBIT_WATER_ROUGHNESS,
      THREE.MathUtils.smoothstep(frame.altitude, 5_000, 400_000),
    );
    commit(frame.instances);
    tiledImagery?.update(instances, frame.view);
    heightCache?.update(instances, frame.view);
    // The caches decide what is baked, and the row carries that decision to the shaders.
    prepareCaches(frame.renderer, frame.view);
    commitRows(instances.count);
  }
  /** Draw heights from this cache. The layer owns it from now on. */
  function setHeightTiles(cache: HeightTileCache) {
    shadowIndexNode.value = cache.shadowIndex;
    heightCoreSize.value = cache.source.tileSize;
    heightGutter.value = cache.source.gutter;
    heightMaxLevel.value = cache.source.maxLevel;
    maximumHeight.value = cache.source.maxMeters;
    minimumHeight.value = cache.source.minMeters;
    heightEncoding.value.set(cache.source.scaleMeters, cache.source.offsetMeters);
    compute?.dispose();
    heightCache?.dispose();
    heightCache = cache;
    heightArrayNode.value = cache.texture;
    compute = createTerrainCompute(
      cache,
      segments,
      {
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
        encoding: heightEncoding,
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
    material.needsUpdate = true;
  }
  return {
    set,
    update,
    /** Stream heights from `source`; `onChange` fires when its tiles or listing change. */
    setHeights(source: HeightSource, slots: number, onChange: () => void) {
      setHeightTiles(createHeightTileCache(source, capacity, onChange, slots, { onError: report }));
    },
    /** @internal Draw a prepared height cache. Tests use it to control fades. */
    setHeightTiles,
    /** The streamed heights, for tile selection and height queries. */
    get heights(): HeightTileCache | undefined {
      return heightCache;
    },
    hasImagery: !!tiledImagery,
    /** Move the height fade clock ahead of selection and queries. */
    advance(now: number) {
      heightCache?.advance(now);
    },
    /** A tile is still fading in. */
    needsFrame: () => !!(tiledImagery?.needsFrame() || heightCache?.needsFrame()),
    /** Every wanted tile of what is shown has arrived or failed, and nothing is fading. */
    settled: () =>
      (tiledImagery?.settled() ?? true) &&
      (elevationEnabled.value > 0 && heightCache ? heightCache.settled() : true),
    imageryStatus: () => tiledImagery?.status(),
    elevationStatus: () => heightCache?.status(),
    /** The imagery source's tiles changed. */
    refreshImagery: () => tiledImagery?.refresh(),
    cacheStats: () => compute?.stats,
    group,
    dispose,
  };
}

const _normal = new THREE.Vector3();
const ORBIT_WATER_ROUGHNESS = 0.31;
const CLOSE_WATER_ROUGHNESS = 0.12;
