import { describe, expect, it } from "vitest";
import {
  checkinCreateSchema,
  entryCreateSchema,
  hasPayload,
  journeyCreateSchema,
  journeyPatchSchema,
  journeyPhotoCreateSchema,
} from "../src/lib/journey";

describe("contrats journal", () => {
  it("journal : titre requis, dates ISO, voyages liés bornés", () => {
    expect(journeyCreateSchema.safeParse({ title: "Islande 2026", started_at: "2026-07-01" }).success).toBe(true);
    expect(journeyCreateSchema.safeParse({ title: "" }).success).toBe(false);
    expect(journeyCreateSchema.safeParse({ title: "x", started_at: "01/07/2026" }).success).toBe(false);
    expect(journeyCreateSchema.safeParse({ title: "x", trip_ids: Array.from({ length: 21 }, (_, i) => i + 1) }).success).toBe(false);
  });

  it("patch journal : statut enum, is_public binaire, champs absents tolérés", () => {
    expect(journeyPatchSchema.safeParse({ status: "done" }).success).toBe(true);
    expect(journeyPatchSchema.safeParse({ is_public: 1 }).success).toBe(true);
    expect(journeyPatchSchema.safeParse({}).success).toBe(true);
    expect(journeyPatchSchema.safeParse({ status: "finished" }).success).toBe(false);
    expect(journeyPatchSchema.safeParse({ is_public: 7 }).success).toBe(false);
  });

  it("check-in : nom + horodatage requis", () => {
    expect(checkinCreateSchema.safeParse({ name: "Reykjavik", checked_in_at: "2026-07-02T10:00:00Z" }).success).toBe(true);
    expect(checkinCreateSchema.safeParse({ name: "X" }).success).toBe(false);
  });

  it("entrée : date ISO obligatoire, corps borné", () => {
    expect(entryCreateSchema.safeParse({ entry_date: "2026-07-02" }).success).toBe(true);
    expect(entryCreateSchema.safeParse({ entry_date: "2026-07-02", body: "a".repeat(20_001) }).success).toBe(false);
    expect(entryCreateSchema.safeParse({}).success).toBe(false);
  });

  it("photo journal : upload interdit via /external, payload obligatoire", () => {
    expect(journeyPhotoCreateSchema.safeParse({ source: "instagram", external_url: "https://www.instagram.com/p/A/" }).success).toBe(true);
    expect(journeyPhotoCreateSchema.safeParse({ source: "upload" }).success).toBe(true); // refusé plus loin par la route
    expect(hasPayload({ external_url: "https://x" })).toBe(true);
    expect(hasPayload({})).toBe(false);
  });
});