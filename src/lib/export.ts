/** Builders d'export purs (testables sans runtime Cloudflare). */

export interface GpxPoint {
  lat: number;
  lng: number;
  name: string;
  desc?: string | null;
  kind?: string;
}

function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function buildGpx(tripTitle: string, points: GpxPoint[]): string {
  const wpts = points
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
    .map(
      (p) =>
        `  <wpt lat="${p.lat}" lon="${p.lng}"><name>${escXml(p.name.slice(0, 200))}</name>` +
        (p.desc ? `<desc>${escXml(p.desc.slice(0, 1000))}</desc>` : "") +
        (p.kind ? `<type>${escXml(p.kind.slice(0, 60))}</type>` : "") +
        `</wpt>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="trek-cloudflare" xmlns="http://www.topografix.com/GPX/1/1">\n<metadata><name>${escXml(tripTitle.slice(0, 200))}</name></metadata>\n${wpts}\n</gpx>`;
}

export interface IcsDay {
  n: number;
  /** YYYY-MM-DD */
  date: string;
  title?: string | null;
  places: string[];
}

function escIcsText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Pliage RFC 5545 (75 octets max par ligne, sans couper un caractère UTF-8). */
export function foldIcsLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  let out = "";
  let start = 0;
  let first = true;
  while (start < bytes.length) {
    // Recule jusqu'à une frontière de caractère UTF-8 (octet non-continuation).
    let end = Math.min(start + 75, bytes.length);
    while (end < bytes.length && end > start && (bytes[end]! & 0xc0) === 0x80) end--;
    if (end === start) end = Math.min(start + 75, bytes.length); // garde-fou
    out += (first ? "" : "\r\n ") + bytes.subarray(start, end).toString("utf8");
    first = false;
    start = end;
  }
  return out;
}

const ICS_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;

export function buildIcs(tripTitle: string, tripId: number, days: IcsDay[]): { ics: string; count: number } {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const dated = days.filter((d) => ICS_DATE_RE.test(d.date ?? ""));
  const events = dated.map((d) => {
    const dt = d.date.replaceAll("-", "").slice(0, 8);
    const summary = d.title?.trim() ? `${tripTitle} — J${d.n} : ${d.title.trim()}` : `${tripTitle} — Jour ${d.n}`;
    const desc = d.places.length ? d.places.join(", ") : "";
    const lines = [
      "BEGIN:VEVENT",
      `UID:trip-${tripId}-day-${d.n}@trek-cloudflare`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${dt}`,
      `SUMMARY:${escIcsText(summary.slice(0, 200))}`,
    ];
    if (desc) lines.push(`DESCRIPTION:${escIcsText(desc.slice(0, 1000))}`);
    lines.push("END:VEVENT");
    return lines.map(foldIcsLine).join("\r\n");
  });
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//trek-cloudflare//trip//FR", ...events, "END:VCALENDAR"].join("\r\n");
  return { ics, count: events.length };
}

const FORECAST_BASE = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE_BASE = "https://archive-api.open-meteo.com/v1/archive";
const DAILY = "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode";
/** Open-Meteo ne sert le forecast que de ~3 jours dans le passé à ~16 jours dans le futur. */
const ARCHIVE_BEFORE_DAYS = 5;

/**
 * URL Open-Meteo journalière. Bascule sur l'archive API quand la fenêtre est
 * entièrement dans le passé (comportement repris du TREK d'origine) ; sinon
 * fenêtre clampée à 16 jours.
 */
export function openMeteoUrl(lat: number, lng: number, startDate: string, endDate: string): string {
  const s = startDate.slice(0, 10);
  let e = endDate.slice(0, 10);
  const archiveCutoff = new Date(Date.now() - ARCHIVE_BEFORE_DAYS * 86400_000).toISOString().slice(0, 10);
  const isPast = e < archiveCutoff;
  if (!isPast) {
    const maxEnd = new Date(new Date(s + "T00:00:00Z").getTime() + 15 * 86400_000).toISOString().slice(0, 10);
    if (e > maxEnd) e = maxEnd;
  }
  const u = new URL(isPast ? ARCHIVE_BASE : FORECAST_BASE);
  u.searchParams.set("latitude", String(lat));
  u.searchParams.set("longitude", String(lng));
  u.searchParams.set("daily", DAILY);
  u.searchParams.set("timezone", "auto");
  u.searchParams.set("start_date", s);
  u.searchParams.set("end_date", e);
  return u.toString();
}
