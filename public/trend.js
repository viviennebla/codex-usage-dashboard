function normalizeDate(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  return null;
}

function shiftDate(date, offset) {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + offset));
  return shifted.toISOString().slice(0, 10);
}

export function alignedTrendDays(rows = [], endDate, count = 30) {
  const datedRows = rows.filter((row) => normalizeDate(row?.date));
  const fallbackEnd = datedRows.at(-1)?.date || new Date().toISOString().slice(0, 10);
  const end = normalizeDate(endDate) || normalizeDate(fallbackEnd);
  const byDate = new Map(datedRows.map((row) => [normalizeDate(row.date), row]));

  return Array.from({ length: count }, (_, index) => {
    const date = shiftDate(end, index - count + 1);
    const row = byDate.get(date);
    return row
      ? { ...row, date }
      : { date, totalTokens: 0, eventCount: 0 };
  });
}
