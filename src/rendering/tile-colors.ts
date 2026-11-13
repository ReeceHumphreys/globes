import { Color, SRGBColorSpace } from "three/webgpu";

const ROOT_COLORS = new Uint32Array([0xff0000, 0x00ff00, 0x0000ff, 0xffff00]);
const scratch = new Color();
const hsl = { h: 0, s: 0, l: 0 };

// Debug-only. Each tile shifts its parent's color, following quadrant bits from the root.
export function tileColor(root: number, level: number, x: number, y: number): number {
  let hex = ROOT_COLORS[root];
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
