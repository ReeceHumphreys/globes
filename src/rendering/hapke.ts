/** Normalizing brightness at nadir/full phase for the fixed 20-degree preset.
 * At incidence=emission=0 the roughness formula reduces to hapkeDisk(1/Sr,1/Sr,1).
 * Evaluate on parameter changes, rather than once for every shaded fragment.
 */
export function hapkeReference(parameters: readonly number[]): number {
  const w = Math.min(0.999, Math.max(0.001, parameters[0]));
  const g = Math.min(0.95, Math.max(-0.95, parameters[1]));
  const b0 = Math.max(0, parameters[2]);
  const tangent = Math.tan((20 * Math.PI) / 180);
  const mu = 1 / Math.sqrt(1 + Math.PI * tangent * tangent);
  const particle = (1 - g * g) / Math.max(0.0001, 1 + 2 * g + g * g) ** 1.5;
  const h = (1 + 2 * mu) / (1 + 2 * mu * Math.sqrt(1 - w));
  return Math.max(0.000001, w * 0.125 * ((1 + b0) * particle + h * h - 1));
}
