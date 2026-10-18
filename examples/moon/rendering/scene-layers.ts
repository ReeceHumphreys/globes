import type { GlobeContext, GlobeFrame, GlobeLayer } from "tiled-globe";
import { createLanderLayer } from "./landers.ts";

export { rockLayer } from "./rocks.ts";

/** Model loading and lighting consume the same body, height, and Sun as terrain. */
export function apolloLayer(baseURL: string): GlobeLayer {
  let landers: ReturnType<typeof createLanderLayer> | undefined;
  return {
    id: "apollo-models",
    attach(context) {
      landers = createLanderLayer(
        baseURL,
        context.requestRender,
        !context.environment?.lightsModels,
      );
      context.scene.add(landers.group);
    },
    update({ context }: GlobeFrame) {
      const { x, y, z } = context.sun.direction;
      landers!.setSun(x, y, z);
      landers!.update(context.camera, context.body.radiusMeters, context.sampleHeight);
    },
    dispose() {
      landers?.dispose();
    },
  };
}

export { createStarSkyLayer as moonSkyLayer } from "../../shared/star-sky.ts";
