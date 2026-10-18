import {
  getIndirectLuminance,
  getSplitScalarIlluminance,
  type AtmosphereContext,
} from "@takram/three-atmosphere/webgpu";
import { Fn, If, dFdx, dFdy, mix, texture, uniform, vec2, vec3, vec4, wgslFn } from "three/tsl";
import {
  DataTexture,
  RedFormat,
  NoColorSpace,
  RepeatWrapping,
  ClampToEdgeWrapping,
  LinearFilter,
  LinearMipmapLinearFilter,
  type Texture,
  type Node,
} from "three/webgpu";
import type { TerrainLighting } from "tiled-globe";
import type { AtmosphereBody } from "./atmosphere-presets.ts";
import marsColorSource from "./shaders/mars-color-grade.wgsl?raw";
import oceanSource from "./shaders/ocean.wgsl?raw";

/** Shared Sun/sky lighting. Water is an Earth-only material, not another mesh. */
export function createAtmosphericSurface(
  atmosphere: AtmosphereContext,
  active: Node<"float">,
  body: AtmosphereBody,
) {
  const emptyMask = new DataTexture(new Uint8Array([0]), 1, 1, RedFormat);
  emptyMask.minFilter = emptyMask.magFilter = LinearFilter;
  emptyMask.needsUpdate = true;
  const mask = texture(emptyMask);
  const waterReady = uniform(0);
  const oceans = uniform(0);
  const roughness = uniform(0.27);
  const ocean = wgslFn(oceanSource);
  const marsColor = body === "mars" ? wgslFn(marsColorSource) : undefined;
  const lighting: TerrainLighting = (inputs) =>
    Fn(() => {
      // This named struct is shared with Takram's camera conversions. Declare
      // it in the root scope, before any conditional light/material branches.
      atmosphere.parametersNode.toStack();
      const result = vec3(0).toVar();
      If(active.greaterThan(0.5).and(inputs.enabled.greaterThan(0.5)), () => {
        // Daylight mosaics already contain the Sun. Keep that shade; only water
        // is lit from the atmospheric tables.
        const graded =
          body === "mars"
            ? mix(
                inputs.fallback,
                marsColor!({ color: inputs.fallback }) as Node<"vec3">,
                inputs.imageryEnabled,
              )
            : inputs.fallback;
        result.assign(graded);
        if (body === "earth") {
          If(oceans.mul(waterReady).mul(inputs.imageryEnabled).greaterThan(0.5), () => {
            const point = atmosphere.matrixWorldToECEF
              .mul(vec4(inputs.position, 1))
              .xyz.mul(atmosphere.parameters.worldToUnit)
              .toVar();
            const radial = point.normalize().toVar();
            // LUTs are undefined below their bottom boundary; geometry is unchanged.
            point.assign(
              radial.mul(
                point
                  .length()
                  .max(
                    atmosphere.parameters.bottomRadius * atmosphere.parameters.worldToUnit + 0.001,
                  ),
              ),
            );
            const sun = atmosphere.sunDirectionECEF;
            const light = getSplitScalarIlluminance(point, sun);
            const direct = light.get("direct") as Node<"vec3">;
            const skyIrradiance = (light.get("indirect") as Node<"vec3">).div(2 * Math.PI);
            // Source: north-first, -180..+180 equirectangular R8 ocean coverage.
            const uv = vec2(
              radial.y
                .atan(radial.x)
                .div(2 * Math.PI)
                .add(0.5),
              radial.z.clamp(-1, 1).acos().div(Math.PI),
            );
            // Longitude wraps at the antimeridian; do not select a blurry mip there.
            const dx = dFdx(uv),
              dy = dFdy(uv);
            const water = mask
              .sample(uv)
              .grad(vec2(dx.x.sub(dx.x.round()), dx.y), vec2(dy.x.sub(dy.x.round()), dy.y))
              .r.toVar();
            If(water.greaterThan(0.001), () => {
              const view = atmosphere.matrixWorldToECEF.mul(vec4(inputs.view, 0)).xyz.normalize();
              const reflection = view.negate().reflect(radial);
              const reflectedSky = getIndirectLuminance(point, reflection, vec2(0), sun);
              // Approximate rough-sky filtering toward hemispheric illumination.
              const sky = mix(
                reflectedSky.get("luminance"),
                skyIrradiance.div(Math.PI),
                roughness.pow2(),
              );
              const radiance = ocean({
                color: inputs.color,
                normal: radial,
                view,
                sun,
                direct,
                indirect: skyIrradiance,
                sky,
                visibility: inputs.sunlight,
                roughness,
              }) as Node<"vec3">;
              result.assign(mix(result, radiance, water));
            });
          });
        }
      }).Else(() => {
        result.assign(inputs.fallback);
      });
      return result;
    })() as Node<"vec3">;
  return {
    lighting,
    setMask(value: Texture) {
      value.colorSpace = NoColorSpace;
      value.flipY = false;
      value.minFilter = value.generateMipmaps ? LinearMipmapLinearFilter : LinearFilter;
      value.magFilter = LinearFilter;
      value.wrapS = RepeatWrapping;
      value.wrapT = ClampToEdgeWrapping;
      value.needsUpdate = true;
      mask.value = value;
      waterReady.value = 1;
    },
    setEnabled(value: boolean) {
      oceans.value = value ? 1 : 0;
    },
    setRoughness(value: number) {
      if (!Number.isFinite(value) || value < 0.08 || value > 1)
        throw new RangeError("Ocean roughness must be between 0.08 and 1");
      roughness.value = value;
    },
    dispose() {
      emptyMask.dispose();
    },
  };
}
