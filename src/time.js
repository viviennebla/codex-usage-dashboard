const formatters = new Map();
const dateKeys = new Map();
const MAX_DATE_KEYS = 100_000;
const LOCAL_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

function formatterFor(timezone) {
  const key = timezone || LOCAL_TIME_ZONE;
  if (!formatters.has(key)) {
    formatters.set(key, new Intl.DateTimeFormat("en-CA", {
      timeZone: key,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }));
  }
  return formatters.get(key);
}

export function dayKey(value = new Date(), timezone) {
  const zone = timezone || LOCAL_TIME_ZONE;
  const cacheable = !(value instanceof Date);
  const cacheKey = cacheable ? `${zone}\u0000${value}` : null;
  if (cacheKey && dateKeys.has(cacheKey)) return dateKeys.get(cacheKey);
  const parts = formatterFor(zone).formatToParts(value instanceof Date ? value : new Date(value));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const result = `${values.year}-${values.month}-${values.day}`;
  if (cacheKey) {
    if (dateKeys.size >= MAX_DATE_KEYS) dateKeys.clear();
    dateKeys.set(cacheKey, result);
  }
  return result;
}

const dateTimeFormatters = new Map();

function dateTimeFormatterFor(timezone) {
  const key = timezone || LOCAL_TIME_ZONE;
  if (!dateTimeFormatters.has(key)) {
    dateTimeFormatters.set(key, new Intl.DateTimeFormat("en-CA", {
      timeZone: key,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }));
  }
  return dateTimeFormatters.get(key);
}

export function startOfDayInstant(date, timezone) {
  const zone = timezone || LOCAL_TIME_ZONE;
  const match = String(date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`Invalid date key: ${date}`);
  const [, year, month, day] = match;
  const target = Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0);
  let guess = target;

  for (let iteration = 0; iteration < 4; iteration += 1) {
    const parts = dateTimeFormatterFor(zone).formatToParts(new Date(guess));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const localAsUtc = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second),
    );
    const delta = localAsUtc - target;
    if (delta === 0) return new Date(guess).toISOString();
    guess -= delta;
  }

  return new Date(guess).toISOString();
}
