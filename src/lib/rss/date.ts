/**
 * RSS 2.0 requires all dates to conform to RFC 822, with the four digit year
 * allowance of RFC 1123. Everything is emitted in GMT so the output is stable
 * regardless of the host's timezone.
 */

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

/**
 * Formats a date as `Wed, 02 Oct 2002 13:00:00 GMT`.
 *
 * @throws RangeError when given an invalid `Date`.
 */
export function toRfc822(date: Date): string {
  const time = date.getTime();
  if (Number.isNaN(time)) {
    throw new RangeError("Cannot format an invalid Date as an RFC 822 timestamp");
  }
  const day = DAYS[date.getUTCDay()];
  const month = MONTHS[date.getUTCMonth()];
  const dayOfMonth = pad(date.getUTCDate());
  const year = pad(date.getUTCFullYear(), 4);
  const hours = pad(date.getUTCHours());
  const minutes = pad(date.getUTCMinutes());
  const seconds = pad(date.getUTCSeconds());
  return `${day}, ${dayOfMonth} ${month} ${year} ${hours}:${minutes}:${seconds} GMT`;
}
