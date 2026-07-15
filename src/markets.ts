/**
 * US equity market-hours awareness for stock tokens.
 *
 * Stock tokens on Robinhood Chain trade 24/7, but the equities they track only
 * price 9:30-16:00 ET on NYSE trading days. Off-hours, pool prices float on
 * on-chain supply/demand alone and can drift from the last close, so trades
 * outside market hours deserve at least a warning (and can be blocked by
 * policy.stocks.blockOffHoursTrades).
 *
 * The calendar is computed, not fetched: weekends, the ten NYSE full holidays
 * (with Sat->Fri / Sun->Mon observation), and the usual 13:00 ET early closes
 * (July 3, day after Thanksgiving, Christmas Eve). Ad-hoc closures such as
 * days of mourning are not modeled.
 */

export interface MarketStatus {
  open: boolean;
  /** One human-readable line, e.g. "US market open (14:05 ET)" */
  detail: string;
}

interface EtParts {
  year: number;
  month: number; // 1-12
  day: number;
  weekday: number; // 0 = Sunday
  minutes: number; // minutes since ET midnight
}

const ET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  weekday: "short",
  hour: "numeric",
  minute: "numeric",
  hour12: false,
});

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function etParts(now: Date): EtParts {
  const parts: Record<string, string> = {};
  for (const p of ET_FMT.formatToParts(now)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: WEEKDAYS.indexOf(parts.weekday),
    // "24" can appear at midnight with hour12: false.
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
  };
}

/** Day-of-week (0 = Sunday) for a calendar date, independent of timezone. */
function dow(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** The n-th (1-based) given weekday of a month, as a day number. */
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  const first = dow(year, month, 1);
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}

function lastWeekday(year: number, month: number, weekday: number): number {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = dow(year, month, daysInMonth);
  return daysInMonth - ((last - weekday + 7) % 7);
}

/** Easter Sunday (Gregorian, anonymous algorithm). Returns [month, day]. */
function easter(year: number): [number, number] {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}

function key(month: number, day: number): string {
  return `${month}-${day}`;
}

/** Shift a fixed-date holiday to its observed weekday (Sat -> Fri, Sun -> Mon). */
function observed(year: number, month: number, day: number): string {
  const w = dow(year, month, day);
  if (w === 6) {
    // Saturday -> Friday. Jan 1 on a Saturday is observed Dec 31 of the prior
    // year; that Dec 31 is handled when computing the prior year's calendar.
    if (day === 1) return "none";
    return key(month, day - 1);
  }
  if (w === 0) return key(month, day + 1); // Sunday -> Monday
  return key(month, day);
}

/** Full-day NYSE holidays for a year, as "month-day" keys. */
function holidays(year: number): Map<string, string> {
  const map = new Map<string, string>();
  const add = (k: string, name: string) => {
    if (k !== "none") map.set(k, name);
  };
  add(observed(year, 1, 1), "New Year's Day");
  // New Year's Day of NEXT year observed on Dec 31 of THIS year.
  if (dow(year + 1, 1, 1) === 6) add(key(12, 31), "New Year's Day (observed)");
  add(key(1, nthWeekday(year, 1, 1, 3)), "Martin Luther King Jr. Day");
  add(key(2, nthWeekday(year, 2, 1, 3)), "Washington's Birthday");
  const [em, ed] = easter(year);
  // Good Friday = Easter - 2 days; Easter is always late March or April.
  const gfDay = ed - 2;
  if (gfDay >= 1) add(key(em, gfDay), "Good Friday");
  else add(key(em - 1, (em === 4 ? 31 : 28) + gfDay), "Good Friday");
  add(key(5, lastWeekday(year, 5, 1)), "Memorial Day");
  add(observed(year, 6, 19), "Juneteenth");
  add(observed(year, 7, 4), "Independence Day");
  add(key(9, nthWeekday(year, 9, 1, 1)), "Labor Day");
  add(key(11, nthWeekday(year, 11, 4, 4)), "Thanksgiving");
  add(observed(year, 12, 25), "Christmas");
  return map;
}

/** 13:00 ET early-close days: "month-day" -> occasion. */
function earlyCloses(year: number, fullHolidays: Map<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  const maybe = (month: number, day: number, name: string) => {
    const k = key(month, day);
    const w = dow(year, month, day);
    if (w !== 0 && w !== 6 && !fullHolidays.has(k)) map.set(k, name);
  };
  maybe(7, 3, "day before Independence Day");
  const dayAfterThanksgiving = nthWeekday(year, 11, 4, 4) + 1;
  maybe(11, dayAfterThanksgiving, "day after Thanksgiving");
  maybe(12, 24, "Christmas Eve");
  return map;
}

const OPEN_MINUTES = 9 * 60 + 30;
const CLOSE_MINUTES = 16 * 60;
const EARLY_CLOSE_MINUTES = 13 * 60;

export function usMarketStatus(now: Date = new Date()): MarketStatus {
  const et = etParts(now);
  const time = `${WEEKDAYS[et.weekday]} ${String(Math.floor(et.minutes / 60)).padStart(2, "0")}:${String(et.minutes % 60).padStart(2, "0")} ET`;

  if (et.weekday === 0 || et.weekday === 6) {
    return { open: false, detail: `US market closed: weekend (${time})` };
  }
  const full = holidays(et.year);
  const k = key(et.month, et.day);
  const holiday = full.get(k);
  if (holiday) {
    return { open: false, detail: `US market closed: ${holiday} (${time})` };
  }
  const early = earlyCloses(et.year, full).get(k);
  const close = early ? EARLY_CLOSE_MINUTES : CLOSE_MINUTES;
  if (et.minutes < OPEN_MINUTES) {
    return { open: false, detail: `US market closed: pre-market, opens 09:30 ET (${time})` };
  }
  if (et.minutes >= close) {
    return {
      open: false,
      detail: `US market closed: after hours${early ? ` (13:00 early close, ${early})` : ""} (${time})`,
    };
  }
  return {
    open: true,
    detail: `US market open${early ? `, 13:00 ET early close (${early})` : ""} (${time})`,
  };
}

/** Extra caution line appended to stock-token quotes/trades while closed. */
export const OFF_HOURS_WARNING =
  "Stock-token pool prices float on on-chain flow while NYSE is closed and can drift from the underlying stock's last close. Expect wider spreads; the gap usually corrects at the next open.";
