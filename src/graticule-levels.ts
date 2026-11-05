// Each divides the one before, so no line moves when the spacing changes.
const LEVELS = [10, 5, 1, 0.5, 0.1, 0.05, 0.01];

/** Line spacing for a view this many degrees across: coarse, fine, and the fine lines' strength. */
export function graticuleLevels(viewDegrees: number): [number, number, number] {
  const wanted = viewDegrees / 3;
  const index = LEVELS.findIndex((level) => level <= wanted);
  if (index === -1) return [LEVELS.at(-1)!, LEVELS.at(-1)!, 0];
  const coarse = LEVELS[index],
    fine = LEVELS[index + 1] ?? coarse;
  if (index === 0) return [coarse, fine, 0];
  return [coarse, fine, 1 - Math.log(wanted / coarse) / Math.log(LEVELS[index - 1] / coarse)];
}
