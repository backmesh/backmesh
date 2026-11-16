// The hero's schedule, shared by HeroDiagram's markup (its resting state)
// and its script: every job's place is a pure function of time t, in seconds.

export const G = {
  DROP: 280, // where the queue meets the install's feed
  QY: 44, // the queue's line
  QP: 28, // queue pitch
  TS: 14, // a travelling job's square
  BOX_Y: 132,
  BOX_H: 66,
  PY: 262, // the clouds' top
  PW: 172,
  PX: [0, 194, 388],
  COLS: 5,
  ROWS: 5,
  SS: 22, // a VM slot
  SG: 8,
  PAD: 18,
  HEAD: 44,
  STEP: 0.9, // s between jobs
  TRAVEL: 3, // s from the queue to a slot
  FADE: 0.7,
  BOOT: 0.8, // s a job's VM appears before the job lands in it
  TRAIL: 2.2, // s the VM's outline lingers after its job ends, then it's deleted
  REST: 60, // the time the markup shows
  // Which cloud each job of a 9-job cycle goes to, and the order a cloud's
  // slots fill in, offset per cloud so the clouds don't fill alike.
  PATTERN: [0, 1, 2, 0, 2, 1, 2, 0, 1],
  ORDER: [
    12, 3, 21, 7, 16, 0, 19, 9, 24, 5, 14, 2, 22, 10, 17, 6, 1, 20, 13, 4, 23,
    8, 15, 11, 18,
  ],
};

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** Job k's cloud, slot and running time in seconds. */
export function job(k: number): [number, number, number] {
  const c = G.PATTERN[k % 9]!;
  const before = G.PATTERN.slice(0, k % 9).filter((v) => v === c).length;
  const idx = Math.floor(k / 9) * 3 + before;
  return [c, G.ORDER[(idx + 9 * c) % 25]!, 18 + ((k * 13) % 17)];
}

export const slotXY = (c: number, s: number) => [
  G.PX[c]! + G.PAD + (s % G.COLS) * (G.SS + G.SG),
  G.PY + G.HEAD + Math.floor(s / G.COLS) * (G.SS + G.SG),
];

/** Each busy slot ("cloud:slot") at t, with its opacity as its job ends. */
export function busyAt(t: number) {
  const busy = new Map<string, number>();
  for (
    let k = Math.max(0, Math.floor((t - 60) / G.STEP));
    k <= t / G.STEP;
    k++
  ) {
    const start = k * G.STEP + G.TRAVEL;
    const [c, s, run] = job(k);
    if (t < start || t > start + run + G.FADE) continue;
    busy.set(
      `${c}:${s}`,
      t <= start + run ? 1 : 1 - (t - start - run) / G.FADE,
    );
  }
  return busy;
}

/** Each VM's outline at t: a VM exists only for its job. It appears while the
 * job travels (BOOT), stays while the job runs, and fades out after (TRAIL),
 * so no slot sits idle. */
export function vmsAt(t: number) {
  const vms = new Map<string, number>();
  for (
    let k = Math.max(0, Math.floor((t - 60) / G.STEP));
    k <= t / G.STEP + G.BOOT / G.STEP + 1;
    k++
  ) {
    const start = k * G.STEP + G.TRAVEL;
    const [c, s, run] = job(k);
    const end = start + run;
    if (t < start - G.BOOT || t > end + G.TRAIL) continue;
    const o =
      t < start
        ? (t - start + G.BOOT) / G.BOOT
        : t <= end
          ? 1
          : 1 - (t - end) / G.TRAIL;
    const key = `${c}:${s}`;
    vms.set(key, Math.max(vms.get(key) ?? 0, o));
  }
  return vms;
}

/** The queue's squares at t: x of each square's centre and its opacity. It
 * steps forward one place per job, then rests. */
export function queueAt(t: number) {
  const q = t / G.STEP;
  const e = smooth(Math.min(1, (q - Math.floor(q)) / 0.45));
  return Array.from({ length: 10 }, (_, j) => {
    const x = G.DROP - (1 + j - e) * G.QP;
    return { x, on: Math.min(1, Math.max(0, (x - 40) / 40)) };
  });
}

const bez = (p: number[][], u: number) =>
  [0, 1].map(
    (i) =>
      (1 - u) ** 3 * p[0]![i]! +
      3 * (1 - u) ** 2 * u * p[1]![i]! +
      3 * (1 - u) * u * u * p[2]![i]! +
      u ** 3 * p[3]![i]!,
  );

/** The jobs in flight at t: centre, size and whether shown. A job goes down
 * the feed, through the install (hidden), along its cloud's branch, then
 * into its slot, growing to the slot's size. */
export function tokensAt(t: number) {
  const out: { x: number; y: number; size: number; shown: boolean }[] = [];
  const by = G.BOX_Y + G.BOX_H;
  for (
    let k = Math.floor(t / G.STEP);
    k >= 0 && t - k * G.STEP < G.TRAVEL;
    k--
  ) {
    const [c, s] = job(k);
    const f = (t - k * G.STEP) / G.TRAVEL;
    const cx = G.PX[c]! + G.PW / 2;
    if (f < 0.2) {
      out.push({
        x: G.DROP,
        y: G.QY + (G.BOX_Y - G.QY) * (f / 0.2),
        size: G.TS,
        shown: true,
      });
    } else if (f < 0.3) {
      out.push({ x: G.DROP, y: G.BOX_Y, size: G.TS, shown: false });
    } else if (f < 0.78) {
      const [x, y] = bez(
        [
          [G.DROP, by],
          [G.DROP, by + 48],
          [cx, G.PY - 48],
          [cx, G.PY],
        ],
        smooth((f - 0.3) / 0.48),
      );
      out.push({ x: x!, y: y!, size: G.TS, shown: true });
    } else {
      const u = smooth((f - 0.78) / 0.22);
      const [sx, sy] = slotXY(c, s);
      const ex = sx! + G.SS / 2;
      const ey = sy! + G.SS / 2;
      out.push({
        x: cx + (ex - cx) * u,
        y: G.PY + (ey - G.PY) * u,
        size: G.TS + (G.SS - G.TS) * u,
        shown: true,
      });
    }
  }
  return out;
}
