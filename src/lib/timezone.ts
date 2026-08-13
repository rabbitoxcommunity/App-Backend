/**
 * §20.3 TIME — every date boundary (today's orders, rollup buckets, credit
 * dueDate, opening hours, invoice periods) uses the tenant's timezone, not
 * UTC. Bucketing in UTC puts a 4am Dubai order on the previous day.
 */

export function dateKeyInTimezone(date: Date, timezone: string): string {
  // en-CA gives YYYY-MM-DD directly.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function timezoneOffsetMinutes(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});

  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return (asUTC - date.getTime()) / 60_000;
}

export function startOfDayInTimezone(dateKey: string, timezone: string): Date {
  const utcGuess = new Date(`${dateKey}T00:00:00.000Z`);
  const offsetMinutes = timezoneOffsetMinutes(utcGuess, timezone);
  return new Date(utcGuess.getTime() - offsetMinutes * 60_000);
}

export function todayKey(timezone: string): string {
  return dateKeyInTimezone(new Date(), timezone);
}
