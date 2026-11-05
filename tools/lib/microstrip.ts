// Microstrip (outer layers): Hammerstad and Jensen 1980, "Accurate models for microstrip computer-aided design", with their
// thickness correction. Wadell, "Transmission Line Design Handbook" (1991), section 3.5. All lengths in mm. The equations
// do not model solder mask. tools/si_pairs.py is the twin: it imports pcbnew, so net-drivers.ts cannot use it.
const ETA0 = 376.73;

/** Impedance of a zero-thickness microstrip in air, u = w/h. */
function z01(u: number): number {
  const f = 6 + (2 * Math.PI - 6) * Math.exp(-((30.666 / u) ** 0.7528));
  return ETA0 / (2 * Math.PI) * Math.log(f / u + Math.sqrt(1 + (2 / u) ** 2));
}

function eeff0(u: number, er: number): number {
  const a = 1 + Math.log((u ** 4 + (u / 52) ** 2) / (u ** 4 + 0.432)) / 49 + Math.log(1 + (u / 18.1) ** 3) / 18.7;
  const b = 0.564 * ((er - 0.9) / (er + 3)) ** 0.053;
  return (er + 1) / 2 + (er - 1) / 2 * (1 + 10 / u) ** (-a * b);
}

/** Z0 and Eeff of a single microstrip with the thickness correction. */
export function microstrip(w: number, h: number, t: number, er: number): { z: number; eeff: number } {
  const u = w / h;
  let du1 = 0;
  let dur = 0;
  if (t > 0) {
    const tn = t / h;
    du1 = tn / Math.PI * Math.log(1 + 4 * Math.E / (tn / Math.tanh(Math.sqrt(6.517 * u)) ** 2));
    dur = 0.5 * (1 + 1 / Math.cosh(Math.sqrt(er - 1))) * du1;
  }
  const u1 = u + du1;
  const ur = u + dur;
  return { z: z01(ur) / Math.sqrt(eeff0(ur, er)), eeff: eeff0(ur, er) * (z01(u1) / z01(ur)) ** 2 };
}
