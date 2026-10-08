import { describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { newShareToken } from "../src/db/client";
import { clampLatLng, decodeCursor, encodeCursor } from "../src/lib/http";
import { parseInstagramUrl } from "../src/photos/instagram";
import { instaPinSchema, loginSchema, photoSharePatchSchema, placeCreateSchema, placesBulkSchema, registerSchema, sharePatchSchema, tripCreateSchema } from "../src/lib/validate";
import { uniqueUsernameFromEmail } from "../src/routes/auth";

describe("parseInstagramUrl", () => {
  it("accepte /p/, /reel/ et /reels/", () => {
    expect(parseInstagramUrl("https://www.instagram.com/p/ABC123xyz/")).toBe("ABC123xyz");
    expect(parseInstagramUrl("https://instagram.com/reel/XYZ-12_3")).toBe("XYZ-12_3");
    expect(parseInstagramUrl("https://www.instagram.com/reels/AbC_9-x/")).toBe("AbC_9-x");
  });
  it("rejette les autres URLs", () => {
    expect(parseInstagramUrl("https://example.com/p/ABC")).toBeNull();
    expect(parseInstagramUrl("https://www.instagram.com/stories/x/123")).toBeNull();
    expect(parseInstagramUrl("not a url")).toBeNull();
  });
});

describe("newShareToken", () => {
  it("génère des tokens base64url uniques de 32 caractères (24 octets)", () => {
    const a = newShareToken();
    const b = newShareToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe("curseurs keyset", () => {
  it("roundtrip encode/decode", () => {
    const cur = encodeCursor("2026-10-05T12:00:00.000Z", 42);
    expect(decodeCursor(cur)).toEqual({ t: "2026-10-05T12:00:00.000Z", id: 42 });
  });
  it("rejette les curseurs invalides", () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor("!!!")).toBeNull();
    expect(decodeCursor(Buffer.from("{}").toString("base64url"))).toBeNull();
  });
});

describe("clampLatLng", () => {
  it("accepte null et valeurs valides", () => {
    expect(clampLatLng(null, null)).toEqual({ lat: null, lng: null });
    expect(clampLatLng(48.85, 2.35)).toEqual({ lat: 48.85, lng: 2.35 });
  });
  it("rejette hors bornes", () => {
    expect(clampLatLng(91, 0)).toEqual({ error: "bad_latlng" });
    expect(clampLatLng(0, 181)).toEqual({ error: "bad_latlng" });
    expect(clampLatLng("abc", 0)).toEqual({ error: "bad_latlng" });
  });
});

describe("contrat auth (parité client d'origine)", () => {
  it("login accepte { email, password } comme le client", () => {
    expect(loginSchema.safeParse({ email: "a@b.c", password: "secret123" }).success).toBe(true);
  });
  it("login accepte l'alias { login } et remember_me", () => {
    const r = loginSchema.safeParse({ login: "demo", password: "x", remember_me: true });
    expect(r.success).toBe(true);
  });
  it("login rejette sans identifiant", () => {
    expect(loginSchema.safeParse({ password: "x" }).success).toBe(false);
    expect(loginSchema.safeParse({ email: "  ", password: "x" }).success).toBe(false);
  });
  it("register accepte sans username (dérivé) + invite_token ignoré", () => {
    const r = registerSchema.safeParse({ email: "jean@example.fr", password: "secret123", invite_token: "abc" });
    expect(r.success).toBe(true);
  });

  it("uniqueUsernameFromEmail dérive depuis l'email", async () => {
    const db = { prepare: () => ({ bind: () => ({ first: async () => null }) }) } as unknown as D1Database;
    expect(await uniqueUsernameFromEmail(db, "Jean.Dupont+tag@example.fr")).toBe("jeanduponttag");
    expect(await uniqueUsernameFromEmail(db, "@@@@")).toBe("user");
  });

  it("uniqueUsernameFromEmail suffixe en cas de collision", async () => {
    const db = { prepare: () => ({ bind: () => ({ first: async () => ({ ok: 1 }) }) }) } as unknown as D1Database;
    const name = await uniqueUsernameFromEmail(db, "demo@x.fr");
    expect(name.startsWith("demo-")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(32);
  });
});

describe("schemas zod", () => {
  it("tripCreate exige un titre, days_count plafonné", () => {
    expect(tripCreateSchema.safeParse({ title: "Islande" }).success).toBe(true);
    expect(tripCreateSchema.safeParse({ title: "  " }).success).toBe(false);
    expect(tripCreateSchema.safeParse({ title: "X", days_count: 61 }).success).toBe(false);
  });
  it("placeCreate borne lat/lng", () => {
    expect(placeCreateSchema.safeParse({ name: "Reykjavik", lat: 64.1, lng: -21.9 }).success).toBe(true);
    expect(placeCreateSchema.safeParse({ name: "X", lat: 91 }).success).toBe(false);
  });
  it("instaPin exige une url (le format est vérifié route-side)", () => {
    expect(instaPinSchema.safeParse({ url: "https://www.instagram.com/p/A/" }).success).toBe(true);
    expect(instaPinSchema.safeParse({}).success).toBe(false);
  });
  it("sharePatch borne les flags", () => {
    expect(sharePatchSchema.safeParse({ share_map: 0 }).success).toBe(true);
    expect(sharePatchSchema.safeParse({ share_map: 2 }).success).toBe(false);
  });
  it("photoSharePatch accepte un déplacement (lat/lng) ou une légende", () => {
    expect(photoSharePatchSchema.safeParse({ lat: 64.1, lng: -21.9 }).success).toBe(true);
    expect(photoSharePatchSchema.safeParse({ caption: "couchant" }).success).toBe(true);
    expect(photoSharePatchSchema.safeParse({ caption: null }).success).toBe(true);
    expect(photoSharePatchSchema.safeParse({ lat: 200 }).success).toBe(false);
    expect(photoSharePatchSchema.safeParse({ place_id: 0 }).success).toBe(false);
  });
  it("placesBulk exige 1..500 lignes valides", () => {
    expect(placesBulkSchema.safeParse({ places: [{ name: "Geysir", lat: 64.3, lng: -20.3 }] }).success).toBe(true);
    expect(placesBulkSchema.safeParse({ places: [] }).success).toBe(false);
    expect(placesBulkSchema.safeParse({ places: [{ name: "" }] }).success).toBe(false);
    expect(placesBulkSchema.safeParse({ places: Array.from({ length: 501 }, () => ({ name: "x" })) }).success).toBe(false);
  });
});
