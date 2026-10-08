import { describe, expect, it } from "vitest";
import { buildGpx, buildIcs, foldIcsLine, openMeteoUrl } from "../src/lib/export";

describe("buildGpx", () => {
  it("génère des wpt échappés et ignore les coords invalides", () => {
    const gpx = buildGpx("Islande & <amis>", [
      { lat: 64.31, lng: -20.3, name: "Geysir", desc: "A & B", kind: "place" },
      { lat: NaN, lng: 0, name: "fantôme" },
    ]);
    expect(gpx).toContain("<name>Islande &amp; &lt;amis&gt;</name>");
    expect(gpx).toContain('lat="64.31" lon="-20.3"');
    expect(gpx).toContain("<desc>A &amp; B</desc>");
    expect(gpx).not.toContain("fantôme");
    expect(gpx.match(/<wpt/g)?.length).toBe(1);
  });
});

describe("buildIcs", () => {
  it("génère des VEVENT datés, ignore les jours sans date", () => {
    const { ics, count } = buildIcs("Islande", 1, [
      { n: 1, date: "2026-07-01", title: "Arrivée", places: ["Geysir", "Gullfoss"] },
      { n: 2, date: "", title: "Sans date", places: [] },
    ]);
    expect(count).toBe(1);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("UID:trip-1-day-1@trek-cloudflare");
    expect(ics).toContain("DTSTART;VALUE=DATE:20260701");
    expect(ics).toContain("SUMMARY:Islande — J1 : Arrivée");
    expect(ics).toContain("DESCRIPTION:Geysir\\, Gullfoss");
  });
});

describe("foldIcsLine", () => {
  it("plie les longues lignes sans couper l'UTF-8", () => {
    const line = "DESCRIPTION:" + "é".repeat(100) + " fin";
    const folded = foldIcsLine(line);
    expect(folded).toContain("\r\n ");
    // Dépliage => identique à l'original.
    expect(folded.replaceAll("\r\n ", "")).toBe(line);
    for (const chunk of folded.split("\r\n")) {
      expect(chunk.startsWith(" ") ? Buffer.byteLength(chunk.slice(1), "utf8") + 1 : Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(76);
    }
  });
  it("laisse les lignes courtes intactes", () => {
    expect(foldIcsLine("SUMMARY:test")).toBe("SUMMARY:test");
  });
});

describe("openMeteoUrl", () => {
  it("clamp la fenêtre future à 16 jours et vise le forecast", () => {
    // Fenêtre ancrée sur « demain » : elle reste dans la plage forecast quelle que soit la date du test.
    const s = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
    const u = new URL(openMeteoUrl(64.1, -21.9, s, "2099-01-01"));
    expect(u.host).toBe("api.open-meteo.com");
    expect(u.searchParams.get("start_date")).toBe(s);
    expect(u.searchParams.get("end_date")).toBe(new Date(new Date(s + "T00:00:00Z").getTime() + 15 * 86400_000).toISOString().slice(0, 10));
    expect(u.searchParams.get("daily")).toContain("weathercode");
  });

  it("bascule sur l'archive pour une fenêtre passée", () => {
    const past = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
    const end = new Date(Date.now() - 25 * 86400_000).toISOString().slice(0, 10);
    const u = new URL(openMeteoUrl(64.1, -21.9, past, end));
    expect(u.host).toBe("archive-api.open-meteo.com");
    expect(u.searchParams.get("start_date")).toBe(past);
    expect(u.searchParams.get("end_date")).toBe(end);
  });
});
