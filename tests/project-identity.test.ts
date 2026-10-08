import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `PROJECT_*` existe en double : dans `src/lib/project.ts` (le Worker) et dans
 * `web/src/identity.ts` (le client). Les deux arbres de compilation sont
 * séparés — le Worker n'a pas de résolution JSON vers `web/`, et le client ne
 * doit pas embarquer de code serveur — donc la duplication est nécessaire.
 *
 * Ce test est le garde-fou : sans lui, changer l'URL du dépôt d'un côté et pas
 * de l'autre produirait un lien de code source cassé dans l'application, ce que
 * personne ne remarkera avant une question de licence.
 *
 * Aucune valeur n'est écrite deux fois ici : le test EXTRAIT les deux fichiers et
 * les compare. Dupliquer les littéraux dans le test ne ferait que créer une
 * troisième copie à désynchroniser.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SERVER = readFileSync(join(ROOT, "src/lib/project.ts"), "utf8");
const CLIENT = readFileSync(join(ROOT, "web/src/identity.ts"), "utf8");

/** Valeur d'un `export const NOM = "…"` dans un source TypeScript. */
function literalOf(src: string, name: string): string | null {
  const m = src.match(new RegExp(`export const ${name} = "([^"]*)"`));
  return m?.[1] ?? null;
}

describe("identité du projet", () => {
  const pairs: [string, string][] = [
    ["PROJECT_NAME", "PROJECT_NAME"],
    ["PROJECT_URL", "PROJECT_URL"],
    ["UPSTREAM_NAME", "UPSTREAM_NAME"],
    ["UPSTREAM_URL", "UPSTREAM_URL"],
  ];

  for (const [serverName, clientName] of pairs) {
    it(`${serverName} est identique côté Worker et côté client`, () => {
      const a = literalOf(SERVER, serverName);
      const b = literalOf(CLIENT, clientName);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a).toBe(b);
    });
  }

  it("le dépôt du code source est l'AGPL qui oblige à le publier", () => {
    // L'AGPL-3.0 §13 impose que le code soit offered à quiconque interagit avec
    // le programme par le réseau. Un dépôt privé ne satisfait pas §6d ; on
    // vérifie donc au moins que l'URL est bien un dépôt public et non un
    // lien vers un serveur privé.
    expect(literalOf(SERVER, "PROJECT_URL")).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+$/);
    expect(literalOf(CLIENT, "PROJECT_URL")).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+$/);
  });

  it("l'amont est crédité et l'URL pointe vers le vrai dépôt", () => {
    expect(literalOf(SERVER, "UPSTREAM_URL")).toBe("https://github.com/liketrek/TREK");
    expect(literalOf(CLIENT, "UPSTREAM_NAME")).toBe("TREK");
  });

  it("LICENSE est bien AGPL-3.0", () => {
    const license = readFileSync(join(ROOT, "LICENSE"), "utf8");
    expect(license).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(license).toContain("Version 3");
  });

  it("MODIFIED.md annonce les modifications, comme l'exige l'AGPL §5", () => {
    const m = readFileSync(join(ROOT, "MODIFIED.md"), "utf8");
    expect(m).toContain("fork modifié");
    expect(m).toContain("AGPL-3.0");
    // §5(a) : la date des modifications.
    expect(m).toMatch(/\d{1,2} \w+ \d{4}/);
  });
});
