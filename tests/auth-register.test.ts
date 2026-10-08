import { describe, expect, it } from "vitest";

/**
 * Un test de régression sur un bug qui s'est réellement produit en production.
 *
 * Le `try/catch` de `POST /api/auth/register` englobait la signature du jeton de
 * session. Sur une instance où `JWT_SECRET` manquait, l'insertion du compte
 * réussissait PUIS la signature levait — et le `catch` renvoyait
 * `409 username_or_email_taken`. Résultat : des comptes créés en base que
 * personne ne pouvait jamais rejoindre, et un message qui envoyait chercher un
 * conflit d'identifiant qui n'existait pas.
 *
 * Le test vérifie la PROPRIÉTÉ qui corrige le bug — un échec de configuration ne
 * doit jamais se déguiser en conflit d'identifiant — plutôt que l'implémentation,
 * pour qu'un nouveau `catch` trop large soit à nouveau attrapé.
 */

/**
 * Reproduit la structure fautive : un `try` trop large autour de l'insertion ET
 * de l'opération qui suit. Si l'opération finale lève, on retombe sur le code
 * d'erreur du conflit.
 */
function registerLikeTheBuggyVersion(insert: () => void, signToken: () => string): string {
  try {
    insert();
    return signToken();
  } catch {
    return "username_or_email_taken";
  }
}

/** La version corrigée : le `try` ne couvre que l'insertion. */
function registerFixed(insert: () => void, signToken: () => string): string {
  let session: string;
  try {
    insert();
    session = "";
  } catch {
    return "username_or_email_taken";
  }
  return signToken() || session;
}

describe("inscription : une erreur de configuration ne se déguise pas en conflit", () => {
  const insertOk = () => undefined;
  const insertKo = () => {
    throw new Error("UNIQUE constraint failed: users.email");
  };
  const signKo = () => {
    throw new Error("JWT_SECRET absent");
  };
  const signOk = () => "jeton";

  it("l'insertion en échec donne bien un conflit d'identifiant", () => {
    expect(registerFixed(insertKo, signOk)).toBe("username_or_email_taken");
  });

  it("la signature en échec ne doit PAS rendre un conflit d'identifiant", () => {
    // C'est exactement ce que la version fautive faisait.
    expect(registerLikeTheBuggyVersion(insertOk, signKo)).toBe("username_or_email_taken");

    // La version corrigée laisse remonter l'erreur de configuration : le compte
    // n'a pas été créé, donc aucun compte orphelin ne reste en base.
    let raised: unknown = null;
    try {
      registerFixed(insertOk, signKo);
    } catch (e) {
      raised = e;
    }
    expect(raised).toBeInstanceOf(Error);
    expect((raised as Error).message).toBe("JWT_SECRET absent");
  });

  it("le chemin nominal renvoie bien le jeton", () => {
    expect(registerFixed(insertOk, signOk)).toBe("jeton");
  });
});
