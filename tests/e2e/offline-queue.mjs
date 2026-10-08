/**
 * E2E — file de mutations hors-ligne (le cœur de l'original : offline-first).
 *
 * Scénario : couper le réseau, créer un voyage, vérifier qu'il est mis en file
 * (et non envoyé), rétablir le réseau, vérifier le rejeu automatique ET
 * l'ABSENCE de doublon côté serveur (protection par X-Idempotency-Key).
 *
 *   E2E_PASSWORD=... node tests/e2e/offline-queue.mjs
 */
import { chromium } from "playwright";

const B = process.env.BASE_URL ?? "https://trek-cloudflare.tckgrg9ytv.workers.dev";
const EMAIL = process.env.E2E_EMAIL ?? "demo@trek.local";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
const TITLE = "Voyage hors-ligne";
if (!PASSWORD) {
  console.error("E2E_PASSWORD manquant.");
  process.exit(1);
}

const failures = [];
function check(label, ok, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const posts = [];
page.on("response", (r) => {
  if (r.url().includes("/api/trips") && r.request().method() === "POST") posts.push(r.status());
});

async function cleanup() {
  await page.evaluate(async (title) => {
    const r = await fetch("/api/trips", { credentials: "include" });
    const j = await r.json();
    for (const t of j.trips.filter((x) => x.title === title)) {
      await fetch(`/api/trips/${t.id}`, { method: "DELETE", credentials: "include" });
    }
  }, TITLE);
}

try {
  await page.goto(B, { waitUntil: "networkidle" });
  await page.fill("#email", EMAIL);
  await page.fill("#pwd", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForTimeout(2500);
  await cleanup(); // état de départ propre : ce test en crée un par exécution

  // --- hors ligne : la création doit être mise en file, pas envoyée ---
  await ctx.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await page.fill("input[placeholder='Nouveau voyage…']", TITLE);
  await page.click("button:has-text('Créer')");
  await page.waitForTimeout(1200);

  const body = ((await page.textContent("body")) ?? "").replace(/\s+/g, " ");
  check("bandeau hors-ligne affiché", body.includes("Hors ligne"));
  check("1 mutation en file", /1 modification/.test(body));
  check("aucun POST pendant la coupure", posts.length === 0, posts.join(","));

  // --- retour réseau : rejeu automatique ---
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(4500);
  check("mutation rejouée", posts.length > 0, `HTTP ${posts.join(",")}`);

  const created = await page.evaluate(async (title) => {
    const r = await fetch("/api/trips", { credentials: "include" });
    const j = await r.json();
    return j.trips.filter((t) => t.title === title).map((t) => t.id);
  }, TITLE);
  check("exactement 1 voyage côté serveur (pas de doublon)", created.length === 1, `ids ${created.join(",")}`);

  const after = ((await page.textContent("body")) ?? "").replace(/\s+/g, " ");
  check("file vidée", !/modification\(s\) en attente/.test(after));

  await cleanup();
} finally {
  if (failures.length > 0) {
    console.error(`\nÉCHECS (${failures.length}) : ${failures.join(", ")}`);
  } else {
    console.log("\nFILE HORS-LIGNE OK");
  }
  await browser.close();
  process.exit(failures.length > 0 ? 1 : 0);
}
