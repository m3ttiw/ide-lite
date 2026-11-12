// Relative dates in Italian ("2 ore fa").

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one} fa` : `${n} ${many} fa`;
}

/** `unixSeconds`: the date to describe. `nowMs`: the current time in milliseconds. */
export function relativeDate(unixSeconds: number, nowMs: number = Date.now()): string {
  const sec = Math.floor(nowMs / 1000 - unixSeconds);
  if (sec < 60) return "adesso";
  const min = Math.floor(sec / 60);
  if (min < 60) return plural(min, "minuto", "minuti");
  const hours = Math.floor(min / 60);
  if (hours < 24) return plural(hours, "ora", "ore");
  const days = Math.floor(hours / 24);
  if (days === 1) return "ieri";
  if (days < 7) return `${days} giorni fa`;
  if (days < 30) return plural(Math.floor(days / 7), "settimana", "settimane");
  if (days < 365) return plural(Math.max(1, Math.floor(days / 30)), "mese", "mesi");
  return plural(Math.floor(days / 365), "anno", "anni");
}

export function fullDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
