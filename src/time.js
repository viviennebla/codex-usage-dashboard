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
