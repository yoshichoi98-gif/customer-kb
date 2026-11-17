// Pacific-time helpers. Cloudflare cron runs in UTC; the report is defined in Pacific time.

const TZ = "America/Los_Angeles";
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function parts(d: Date) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hour12: false });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(d)) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, wd: WEEKDAYS[o.weekday] };
}

function offsetMs(d: Date): number {
  const p = parts(d);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(d.getTime() / 1000) * 1000;
}

/** A Pacific wall-clock time -> the UTC instant. */
function ptToUtc(y: number, mo: number, d: number, h: number): Date {
  const guess = Date.UTC(y, mo - 1, d, h);
  return new Date(guess - offsetMs(new Date(guess)));
}

/** The most recent report moment (e.g. Tuesday 18:00 PT) at or before `now`. */
export function lastReportTime(now: Date, weekday: number, hour: number): Date {
  const p = parts(now);
  const back = (p.wd - weekday + 7) % 7;
  const base = new Date(Date.UTC(p.y, p.mo - 1, p.d) - back * 86400_000);
  let t = ptToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), hour);
  if (t > now) {
    const prev = new Date(base.getTime() - 7 * 86400_000);
    t = ptToUtc(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate(), hour);
  }
  return t;
}

/** YYYY-MM-DD of a moment, in Pacific time. */
export function ptDate(d: Date): string {
  const p = parts(d);
  return `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** "9/30" style, Pacific time. */
export function short(d: Date | string): string {
  const p = parts(typeof d === "string" ? new Date(d) : d);
  return `${p.mo}/${p.d}`;
}

/** "Sep 29 to Oct 6" */
export function rangeLabel(from: Date, to: Date): string {
  const f = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric" }).format(d);
  return `${f(from)} to ${f(to)}`;
}
