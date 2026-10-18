/** Independent scalar oracle for upstream sampleWeather/sampleMedia equations.
 * Source and MIT notice: examples/planets/assets/clouds/LICENSE.txt.
 * Used only for validation; this is not the runtime cloud implementation.
 */
export interface DensityCase {
  height: number;
  weather: number;
  shape: number;
  detail: number;
  coverage: number;
  detailAmount: number;
}
const saturate = (x: number) => Math.min(1, Math.max(0, x));
const mix = (a: number, b: number, t: number) => a * (1 - t) + b * t;
export function upstreamDensity(c: DensityCase): number {
  if (c.height <= 0 || c.height >= 1 || c.coverage <= 0) return 0;
  const roundedHeight = 1 - (saturate(c.height) ** 0.35 * 2 - 1) ** 2;
  const minimumWeather = 1 - c.coverage * roundedHeight;
  const localWeather = mix(c.weather, 1, 0.6);
  const weatherDensity = saturate((localWeather - minimumWeather) / 0.6);
  const minimumShape = 1 - c.shape;
  let result = saturate((weatherDensity - minimumShape) / Math.max(1e-6, c.shape));
  if (c.detailAmount > 0) {
    const relativeHeight = saturate((c.height - 0.2) / 0.2);
    const erosion = mix(c.detail ** 6, 1 - c.detail, relativeHeight) * 0.5;
    const detailed = saturate((result * 2 - erosion) / (1 - erosion));
    result = mix(result, detailed, c.detailAmount);
  }
  return saturate(result * (0.75 * c.height + 0.25));
}
export function densityCases(): DensityCase[] {
  const cases: DensityCase[] = [];
  for (const height of [0, 0.01, 0.14, 0.25, 0.4, 0.7, 0.95, 1])
    for (const weather of [0, 0.25, 0.6, 1])
      for (const shape of [0, 0.44, 0.8, 1])
        for (const coverage of [0, 0.3, 0.48, 1])
          for (const detailAmount of [0, 0.5, 1])
            cases.push({ height, weather, shape, coverage, detailAmount, detail: 0.71 });
  return cases;
}
