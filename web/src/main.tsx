import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { startAutoReplay } from "./offline";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Service worker : shell + lectures hors-ligne.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* le SW est un confort : son échec ne doit pas casser l'app */
    });
  });
}

// Rejeu des mutations en attente au retour du réseau.
startAutoReplay();