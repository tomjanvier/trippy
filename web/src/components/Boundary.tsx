import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Garde d'erreur autour de la carte.
 *
 * La carte est le seul morceau de l'application qui dépend d'une géométrie
 * tierce (Natural Earth) et d'une projection. Si ce calcul lève, React démonte
 * l'arbre entier et l'atlas disparaît — alors que la table des matières
 * ci-dessous, elle, va très bien. Cette garde garde l'une sans l'autre.
 *
 * Un `try/catch` autour du rendu ne suffirait pas : React journalise l'erreur et
 * remonte jusqu'à la racine de toute façon. Il faut un composant.
 */
interface Props {
  children: ReactNode;
  /** Rendu de repli quand le rendu des enfants lève. */
  fallback?: ReactNode;
}

interface State {
  failed: boolean;
}

export class Boundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Utile en local : sans cela, l'erreur n'apparaît que dans la console et
    // devient impossible à rattacher à la carte.
    console.error("Rendu en échec :", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        this.props.fallback ?? (
          <div className="empty">
            <b>La carte n'a pas pu s'afficher.</b>
            Les pays restent accessibles par la liste en dessous.
          </div>
        )
      );
    }
    return this.props.children;
  }
}
