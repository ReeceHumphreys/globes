import { sgp4, twoline2satrec } from "satellite.js";
import { centerMu, type OrbitEphemeris } from "./ephemeris.ts";
import { resolveFrame, sceneMatrix, toScene } from "./frames.ts";

const temeToFixed = resolveFrame("Earth", "TEME");

function checksum(line: string): boolean {
  let sum = 0;
  for (let i = 0; i < 68; i++) {
    const c = line[i];
    if (c >= "0" && c <= "9") sum += c.charCodeAt(0) - 48;
    else if (c === "-") sum++;
  }
  return sum % 10 === Number(line[68]);
}

/**
 * Parse two- or three-line element sets (an optional name line, including CelesTrak's
 * `0 NAME` form). Each set propagates with SGP4/SDP4 and is rotated from TEME to
 * Earth-fixed axes. Accuracy degrades with distance from the element epoch.
 */
export function parseTle(text: string): OrbitEphemeris[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  const result: OrbitEphemeris[] = [];
  for (let i = 0; i < lines.length; i++) {
    let name: string | undefined;
    if (!lines[i].startsWith("1 ")) {
      name = lines[i].replace(/^0 /, "").trim();
      i++;
    }
    const line1 = lines[i],
      line2 = lines[i + 1];
    if (!line1?.startsWith("1 ") || !line2?.startsWith("2 "))
      throw new SyntaxError(`Expected TLE lines 1 and 2 near line ${i + 1}`);
    if (line1.length < 69 || line2.length < 69 || !checksum(line1) || !checksum(line2))
      throw new SyntaxError(`Invalid TLE checksum or length near line ${i + 1}`);
    if (line1.slice(2, 7) !== line2.slice(2, 7))
      throw new SyntaxError(`TLE catalog numbers differ near line ${i + 1}`);
    i++;
    result.push(tleEphemeris(line1, line2, name));
  }
  return result;
}

function tleEphemeris(line1: string, line2: string, name?: string): OrbitEphemeris {
  const satrec = twoline2satrec(line1, line2);
  if (satrec.error) throw new RangeError(`Invalid TLE elements for ${satrec.satnum}`);
  const id = satrec.satnum.trim();
  const vector = new Float64Array(3);
  const propagate = (timeMs: number) => {
    const minutes = (timeMs / 86_400_000 + 2_440_587.5 - satrec.jdsatepoch) * 1440;
    const state = sgp4(satrec, minutes);
    return state && typeof state.position === "object" ? state : undefined;
  };
  return {
    id,
    name: name || id,
    center: "Earth",
    periodSeconds: ((2 * Math.PI) / satrec.no) * 60,
    mu: centerMu("Earth"),
    // TEME is quasi-inertial: SGP4's own frame, rotated to Earth-fixed by sidereal time.
    inertialStateAt(timeMs, position, velocity) {
      const state = propagate(timeMs);
      if (!state) return false;
      const { x, y, z } = state.position;
      toScene([x * 1000, y * 1000, z * 1000], position);
      if (velocity) {
        const v = state.velocity as { x: number; y: number; z: number };
        toScene([v.x * 1000, v.y * 1000, v.z * 1000], velocity);
      }
      return true;
    },
    inertialToFixed(timeMs, out) {
      sceneMatrix(temeToFixed, timeMs, out);
      return true;
    },
    positionAt(timeMs, out) {
      const state = propagate(timeMs);
      if (!state) return false;
      vector[0] = state.position.x * 1000;
      vector[1] = state.position.y * 1000;
      vector[2] = state.position.z * 1000;
      temeToFixed(timeMs, vector);
      toScene(vector, out);
      return true;
    },
  };
}
