import { Color, SRGBColorSpace } from "three/webgpu";

const FACE_COLORS = new Uint32Array([0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff]);
const scratch = new Color();
const hsl = { h: 0, s: 0, l: 0 };

// Debug-only presentation. Follow the quadrant bits from root to leaf to keep
// the previous parent-derived palette, without allocating or parsing path strings.
export function tileColor(face: number, level: number, x: number, y: number): number {
  let hex = FACE_COLORS[face];
  for (let shift = level - 1; shift >= 0; shift--) {
    const u = ((x >>> shift) & 1) * 2 - 1;
    const v = ((y >>> shift) & 1) * 2 - 1;
    scratch.setHex(hex).getHSL(hsl, SRGBColorSpace);
    hex = scratch
      .setHSL(
        hsl.h + u * 0.025,
        Math.max(0.55, hsl.s * 0.9),
        0.5 + (hsl.l - 0.5) * 0.5 + v * 0.14,
        SRGBColorSpace,
      )
      .getHex();
  }
  return hex;
}
