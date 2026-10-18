#include <algorithm>
#include <cstdint>
#include <cstdlib>

// One-shot numeric kernel. Output is uint16 words, in this order:
// each reduced level's minimum then maximum, row minima, row maxima, max X/Y steps.
// Level zero is the original input and is not duplicated in the output.
extern "C" {
void* bounds_alloc(uint32_t bytes) { return std::malloc(bytes); }
void bounds_free(void* pointer) { std::free(pointer); }

int bounds_build(uint32_t width, uint32_t height, const uint16_t* input,
                 uint16_t* output) {
  if (!width || !height || width > 8192 || height > 8192 || !input || !output)
    return -1;
  const uint16_t* previousMin = input;
  const uint16_t* previousMax = input;
  uint32_t previousWidth = width, previousHeight = height;
  uint16_t* cursor = output;
  while (previousWidth > 1 || previousHeight > 1) {
    const uint32_t w = (previousWidth + 1) / 2, h = (previousHeight + 1) / 2;
    uint16_t* minimum = cursor;
    uint16_t* maximum = cursor + w * h;
    cursor += 2 * w * h;
    for (uint32_t y = 0; y < h; ++y) {
      for (uint32_t x = 0; x < w; ++x) {
        uint16_t lo = 65535, hi = 0;
        for (uint32_t dy = 0; dy < 2 && 2 * y + dy < previousHeight; ++dy) {
          for (uint32_t dx = 0; dx < 2 && 2 * x + dx < previousWidth; ++dx) {
            const uint32_t index = (2 * y + dy) * previousWidth + 2 * x + dx;
            lo = std::min(lo, previousMin[index]);
            hi = std::max(hi, previousMax[index]);
          }
        }
        minimum[y * w + x] = lo;
        maximum[y * w + x] = hi;
      }
    }
    previousMin = minimum;
    previousMax = maximum;
    previousWidth = w;
    previousHeight = h;
  }
  uint16_t* rowMin = cursor;
  uint16_t* rowMax = cursor + height;
  uint32_t stepX = 0, stepY = 0;
  for (uint32_t y = 0; y < height; ++y) {
    uint16_t lo = 65535, hi = 0;
    const uint16_t* row = input + y * width;
    for (uint32_t x = 0; x < width; ++x) {
      const int value = row[x];
      lo = std::min(lo, row[x]);
      hi = std::max(hi, row[x]);
      stepX = std::max(stepX, uint32_t(std::abs(value - row[x + 1 == width ? 0 : x + 1])));
      if (y + 1 < height)
        stepY = std::max(stepY, uint32_t(std::abs(value - row[width + x])));
    }
    rowMin[y] = lo;
    rowMax[y] = hi;
  }
  cursor[2 * height] = uint16_t(stepX);
  cursor[2 * height + 1] = uint16_t(stepY);
  return 0;
}
}
