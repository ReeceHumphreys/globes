import type { GlobeContext, GlobeLayer } from "tiled-globe";
import type { Scene, Texture } from "three/webgpu";
import { loadStarBackground } from "./star-background.ts";

/** The optional sky streams after attach; removal also handles a late texture. */
export function createStarSkyLayer(): GlobeLayer {
  let context: GlobeContext | undefined;
  let sky: Texture | undefined;
  let previous: Scene["background"] = null;
  let previousIntensity = 1;
  return {
    id: "star-sky",
    attach(next) {
      context = next;
      previous = context.scene.background;
      previousIntensity = context.scene.backgroundIntensity;
      void loadStarBackground()
        .then((texture) => {
          if (next.signal.aborted) {
            texture.dispose();
            return;
          }
          sky = texture;
          next.scene.background = texture;
          next.scene.backgroundIntensity = 0.04;
          next.requestRender();
        })
        .catch((error) => {
          if (!next.signal.aborted) next.reportError(error);
        });
    },
    update() {},
    dispose() {
      if (context && sky && context.scene.background === sky) {
        context.scene.background = previous;
        context.scene.backgroundIntensity = previousIntensity;
      }
      sky?.dispose();
    },
  };
}
