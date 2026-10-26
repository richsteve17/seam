/** ISO 8601 timestamps with a numeric offset, in the user's timezone (default America/New_York). */

export function userTimezone(): string {
  return process.env.SEAM_TZ || "America/New_York";
}

/** Returns e.g. 2026-10-26T11:47:28-04:00 for the configured timezone. */
export function nowIso(tz: string = userTimezone(), date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    timeZoneName: "longOffset",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  let offset = get("timeZoneName").replace("GMT", ""); // "-04:00" or "" for UTC
  if (offset === "") offset = "+00:00";
  if (/^[+-]\d{2}$/.test(offset)) offset += ":00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${offset}`;
}
