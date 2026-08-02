import Link from "next/link";

export default function NotFound() {
  return (
    <div className="container">
      <h1>Page introuvable</h1>
      <p className="muted">La ressource demandée n'existe pas ou a été déplacée.</p>
      <p>
        <Link className="btn" href="/">
          Retour à l'accueil
        </Link>
      </p>
    </div>
  );
}
