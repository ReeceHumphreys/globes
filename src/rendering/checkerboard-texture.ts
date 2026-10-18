import {
  DataTexture,
  RGBAFormat,
  UnsignedByteType,
  SRGBColorSpace,
  LinearMipmapLinearFilter,
  LinearFilter,
} from "three/webgpu";

// One reusable UV test image. Numbers are (column,row) within each CUBE FACE,
// not geographic addresses. Pixels are stored bottom-up so row 0 is v=0.
const glyphs: Record<string, string[]> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  ",": ["00000", "00000", "00000", "00000", "00110", "00100", "01000"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
};
export function createCheckerboardTexture(): DataTexture {
  const size = 512,
    cells = 4,
    cell = size / cells;
  const pixels = new Uint8Array(size * size * 4);
  function pixel(x: number, y: number, r: number, g: number, b: number) {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
    pixels[i + 3] = 255;
  }
  function rect(x: number, y: number, w: number, h: number, color: readonly number[]) {
    for (let py = y; py < y + h; py++)
      for (let px = x; px < x + w; px++) pixel(px, py, color[0], color[1], color[2]);
  }
  function text(label: string, x: number, y: number, scale: number, color: readonly number[]) {
    for (const char of label) {
      const glyph = glyphs[char];
      for (let row = 0; row < 7; row++)
        for (let col = 0; col < 5; col++) {
          if (glyph[row][col] === "1")
            rect(x + col * scale, y + (6 - row) * scale, scale, scale, color);
        }
      x += 6 * scale;
    }
  }
  for (let row = 0; row < cells; row++)
    for (let col = 0; col < cells; col++) {
      const light = (row + col) % 2 === 0;
      rect(col * cell, row * cell, cell, cell, light ? [230, 235, 242] : [48, 57, 73]);
      text(
        `${col},${row}`,
        col * cell + 13,
        row * cell + 43,
        6,
        light ? [22, 28, 38] : [245, 248, 255],
      );
    }
  // Distinct borders expose flips and make tile edges visible.
  rect(0, 0, size, 5, [245, 90, 80]); // v=0: red
  rect(0, size - 5, size, 5, [245, 210, 80]); // v=1: yellow
  rect(0, 0, 5, size, [80, 220, 140]); // u=0: green
  rect(size - 5, 0, 5, size, [90, 150, 250]); // u=1: blue
  // +U rightward along bottom; +V upward along left.
  rect(150, 12, 210, 4, [245, 90, 80]);
  rect(12, 150, 4, 210, [80, 220, 140]);
  for (let d = 0; d < 16; d++) {
    rect(360 - d, 14 - d, 2, 2, [245, 90, 80]);
    rect(360 - d, 14 + d, 2, 2, [245, 90, 80]);
    rect(14 - d, 360 - d, 2, 2, [80, 220, 140]);
    rect(14 + d, 360 - d, 2, 2, [80, 220, 140]);
  }
  text("U+", 230, 22, 3, [245, 90, 80]);
  text("V+", 22, 230, 3, [80, 220, 140]);
  const texture = new DataTexture(pixels, size, size, RGBAFormat, UnsignedByteType);
  texture.name = "Face-wide numbered UV checkerboard";
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
