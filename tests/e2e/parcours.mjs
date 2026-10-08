/**
 * E2E — parcours principal contre la prod (ou un Worker local si BASE_URL le pointe).
 * Couvre : PWA, connexion, liste des voyages, détail (plan/réservations/budget/carte),
 * coupure réseau et retour.
 *
 *   node tests/e2e/parcours.mjs
 *   BASE_URL=http://localhost:8787 node tests/e2e/parcours.mjs
 */
import { chromium } from "playwright";

const B = process.env.BASE_URL ?? "https://trek-cloudflare.tckgrg9ytv.workers.dev";
const EMAIL = process.env.E2E_EMAIL ?? "demo@trek.local";
const PASSWORD = process.env.E2E_PASSWORD ?? "";
if (!PASSWORD) {
  console.error("E2E_PASSWORD manquant (et E2E_EMAIL si le compte diffère).");
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
const jsErrors = [];
page.on("pageerror", (e) => jsErrors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") jsErrors.push(m.text().slice(0, 140));
});

try {
  await page.goto(B, { waitUntil: "networkidle" });
  check("titre", (await page.title()).includes("TREK"));

  await page.waitForTimeout(1200);
  const sw = await page.evaluate(() => "serviceWorker" in navigator);
  check("service worker supporté", sw);

  await page.fill("#email", EMAIL);
  await page.fill("#pwd", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForTimeout(2500);
  const afterLogin = ((await page.textContent("body")) ?? "").replace(/\s+/g, " ");
  check("connexion + navigation", afterLogin.includes("Journaux") && afterLogin.includes("Déconnexion"));

  check("liste des voyages chargée", !afterLogin.includes("Chargement…"), afterLogin.slice(0, 60));
  const openBtn = page.locator("button:has-text('Ouvrir')").first();
  if (await openBtn.count()) {
    await openBtn.click();
    await page.waitForTimeout(3000);
    const body = ((await page.textContent("body")) ?? "").replace(/\s+/g, " ");
    check("détail du voyage", body.includes("Plan du voyage"));
    check("carte Leaflet", (await page.locator(".leaflet-container").count()) > 0);
    check("panneaux planification", body.includes("Réservations") && body.includes("Budget"));
  } else {
    check("aucun voyage à ouvrir (base vide)", true, "cas non applicable");
  }

  await ctx.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await page.waitForTimeout(600);
  check("bandeau hors-ligne", ((await page.textContent("body")) ?? "").includes("Hors ligne"));
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(2000);
  check("survie au retour du réseau", (await page.locator(".leaflet-container").count()) > 0);

  check("aucune erreur JS", jsErrors.length === 0, jsErrors.slice(0, 3).join(" | "));
} finally {
  if (failures.length > 0) {
    console.error(`\nÉCHECS (${failures.length}) : ${failures.join(", ")}`);
  } else {
    console.log("\nPARCOURS OK");
  }
  await browser.close();
  process.exit(failures.length > 0 ? 1 : 0);
}
