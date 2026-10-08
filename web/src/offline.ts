/**
 * File de mutations hors-ligne ( IndexedDB ).
 *
 * C'est le mécanisme central du client d'origine : une écriture faite sans réseau
 * est mise en file, puis rejouée au retour de la connexion avec un
 * `X-Idempotency-Key` stable — donc un rejeu ne peut pas double-appliquer.
 *
 * L'ordre est préservé (une seule file) : les requêtes d'un même voyage doivent
 * être appliquées dans l'ordre où l'utilisateur les a faites.
 */

const DB_NAME = "trek-offline";
const STORE = "mutations";
const META = "meta";

interface QueuedMutation {
  id?: number;
  key: string;
  method: string;
  path: string;
  body: string | null;
  createdAt: number;
  attempts: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(META)) {
          db.createObjectStore(META, { keyPath: "k" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const req = fn(db.transaction(store, mode).objectStore(store));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

export async function enqueue(m: Omit<QueuedMutation, "id" | "attempts">): Promise<void> {
  await tx(META, "readwrite", (s) => s.put({ k: "lastMutationAt", v: Date.now() }));
  await tx(STORE, "readwrite", (s) => s.put({ ...m, attempts: 0 }));
  // Le bandeau doit refléter immédiatement le nouvel état de la file, sinon il
  // affiche 0 alors qu'une modification est en attente.
  await notifyAll();
}

export async function listQueued(): Promise<QueuedMutation[]> {
  const all = await tx<QueuedMutation[]>(STORE, "readonly", (s) => s.getAll() as IDBRequest<QueuedMutation[]>);
  return (all ?? []).sort((a, b) => a.createdAt - b.createdAt);
}

export async function removeQueued(key: string): Promise<void> {
  await tx(STORE, "readwrite", (s) => s.delete(key));
}

export function queuedCount(): Promise<number> {
  return tx<number>(STORE, "readonly", (s) => s.count()).then((n) => n ?? 0);
}

// ---------- réseau ----------

type Listener = (pending: number, online: boolean) => void;
const listeners = new Set<Listener>();

export function onQueueChange(fn: Listener): () => void {
  listeners.add(fn);
  const notify = async () => fn(await queuedCount(), navigator.onLine);
  void notify();
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("online", notify);
    window.removeEventListener("offline", notify);
  };
}

/**
 * Rejoue la file. Chaque mutation porte sa `X-Idempotency-Key` d'origine : si le
 * serveur l'a déjà vue, il répond avec la réponse mémorisée au lieu de réappliquer.
 * On s'arrête à la première erreur réseau pour garder l'ordre.
 *
 * Verrou d'exclusion : `online` peut déclencher deux rejeux (événement navigateur +
 * appel manuel) qui lisaient la file avant que l'un ne retire l'entrée — le même
 * voyage aurait été créé deux fois. Un rejeu à la fois, les autres partagent sa
 * promesse.
 */
let inflight: Promise<{ sent: number; failed: number }> | null = null;

/** 425 = traitement identique en cours (le serveur réserve la clé) : on retente. */
function isRetryable(status: number): boolean {
  return status === 425 || status === 429 || status >= 500;
}

async function replayOnce(): Promise<{ sent: number; failed: number }> {
  if (!navigator.onLine) return { sent: 0, failed: 0 };
  const queue = await listQueued();
  let sent = 0;
  let failed = 0;
  for (const m of queue) {
    try {
      const res = await fetch(m.path, {
        method: m.method,
        headers: {
          "Content-Type": "application/json",
          "X-Idempotency-Key": m.key,
          ...(getTokenHeader() ? { Authorization: getTokenHeader()! } : {}),
        },
        body: m.body ?? undefined,
        credentials: "include",
      });
      if (res.ok || (!isRetryable(res.status) && res.status >= 400)) {
        // 2xx = appliqué ; 4xx définitif = refusé par le serveur (on ne boucle pas) ;
        // dans les deux cas la mutation sort de la file.
        await removeQueued(m.key);
        sent++;
      } else {
        // 425/429/5xx : on garde l'entrée et on s'arrête pour préserver l'ordre.
        failed++;
        break;
      }
    } catch {
      failed++;
      break; // réseau toujours coupé : ordre préservé pour le prochain essai
    }
  }
  await notifyAll();
  return { sent, failed };
}

export function replayQueue(): Promise<{ sent: number; failed: number }> {
  if (inflight) return inflight;
  inflight = replayOnce().finally(() => {
    inflight = null;
  });
  return inflight;
}

function getTokenHeader(): string | null {
  try {
    return localStorage.getItem("trek_token");
  } catch {
    return null;
  }
}

async function notifyAll(): Promise<void> {
  const n = await queuedCount();
  for (const fn of listeners) fn(n, navigator.onLine);
}

/** Déclenche un rejeu dès que la connexion revient. */
export function startAutoReplay(): () => void {
  const run = () => {
    void replayQueue().then((r) => {
      if (r.sent > 0) window.dispatchEvent(new CustomEvent("trek:replayed", { detail: r }));
    });
  };
  window.addEventListener("online", run);
  // Au démarrage : si des mutations sont en attente, on tente un rejeu.
  void queuedCount().then((n) => {
    if (n > 0) run();
  });
  return () => window.removeEventListener("online", run);
}
