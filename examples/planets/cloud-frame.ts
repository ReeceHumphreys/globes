import { Matrix4, Vector3, type PerspectiveCamera } from "three/webgpu";

/** Static weather needs a new image only when its view or lighting changes. */
export class CloudFrameCache {
  private revision = -1;
  private width = 0;
  private height = 0;
  private view = new Matrix4();
  private projection = new Matrix4();
  private body = new Matrix4();
  private sun = new Vector3();

  matches(
    camera: PerspectiveCamera,
    sun: Vector3,
    body: Matrix4,
    revision: number,
    width: number,
    height: number,
  ): boolean {
    return (
      this.revision === revision &&
      this.width === width &&
      this.height === height &&
      this.view.equals(camera.matrixWorld) &&
      this.projection.equals(camera.projectionMatrix) &&
      this.body.equals(body) &&
      this.sun.equals(sun)
    );
  }

  commit(
    camera: PerspectiveCamera,
    sun: Vector3,
    body: Matrix4,
    revision: number,
    width: number,
    height: number,
  ): void {
    this.revision = revision;
    this.width = width;
    this.height = height;
    this.view.copy(camera.matrixWorld);
    this.projection.copy(camera.projectionMatrix);
    this.body.copy(body);
    this.sun.copy(sun);
  }
}

/** Half the drawing-buffer dimensions, bounded independently of display DPR. */
export function cloudFrameSize(
  width: number,
  height: number,
  pixelBudget: number,
): [number, number] {
  const scale = Math.min(0.5, Math.sqrt(pixelBudget / (width * height)));
  return [Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale))];
}
