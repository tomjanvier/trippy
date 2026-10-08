import { useEffect, useState } from "react";
import { onQueueChange } from "../offline";

/** Bandeau d'état réseau + file de mutations hors-ligne. */
export function OfflineBadge() {
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => onQueueChange((n, o) => {
    setPending(n);
    setOnline(o);
  }), []);

  if (online && pending === 0) return null;
  return (
    <div
      style={{
        padding: "6px 20px",
        fontSize: 13,
        background: online ? "#14532d" : "#7c2d12",
        color: "#fff",
        textAlign: "center",
      }}
    >
      {online
        ? `${pending} modification(s) en attente d'envoi…`
        : `Hors ligne — ${pending} modification(s) en file, envoyées au retour du réseau.`}
    </div>
  );
}
