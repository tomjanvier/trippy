import { useState } from "react";
import { auth } from "../api";

export function Login({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      if (mode === "login") await auth.login({ email, password });
      else await auth.register({ email, password });
      onDone();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "échec");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <form className="card stack auth-wrap" onSubmit={submit}>
        <div>
          <h2>TREK</h2>
          <div className="muted">Voyages, lieux et photos partagées — sur Cloudflare.</div>
        </div>
        <div>
          <label htmlFor="email">Email</label>
          <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label htmlFor="pwd">Mot de passe</label>
          <input
            id="pwd"
            type="password"
            required
            minLength={mode === "register" ? 8 : 1}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {mode === "register" && <div className="muted">8 caractères minimum.</div>}
        </div>
        {err && <div className="error">{err}</div>}
        <button type="submit" disabled={busy}>
          {busy ? "…" : mode === "login" ? "Se connecter" : "Créer un compte"}
        </button>
        <div className="row end">
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setErr(null);
            }}
          >
            {mode === "login" ? "Créer un compte" : "J'ai déjà un compte"}
          </button>
        </div>
      </form>
    </main>
  );
}