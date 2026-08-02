import { Component, type ReactNode } from "react";
import { RouterProvider } from "react-router";
import { router } from "./routes";

/* ── Lightweight loading spinner (shown while lazy chunks load) ── */
function GlobalLoader() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#f8fafc",
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          border: "3px solid #e2e8f0",
          borderTopColor: "#1d4ed8",
          borderRadius: "50%",
          animation: "fxspin .7s linear infinite",
        }}
      />
      <style>{`@keyframes fxspin { to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}

/* ── Error Boundary — catches dynamic‑import / chunk failures ── */
interface EBState {
  hasError: boolean;
  error?: Error;
}

class ErrorBoundary extends Component<{ children: ReactNode }, EBState> {
  state: EBState = { hasError: false };

  static getDerivedStateFromError(error: Error): EBState {
    return { hasError: true, error };
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: undefined });
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      const isChunkError =
        this.state.error?.message?.includes("dynamically imported module") ||
        this.state.error?.message?.includes("Failed to fetch") ||
        this.state.error?.message?.includes("Loading chunk");

      return (
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#f8fafc",
            padding: 24,
          }}
        >
          <div style={{ textAlign: "center", maxWidth: 420 }}>
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: 16,
                background: "#1d4ed8",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                margin: "0 auto 20px",
              }}
            >
              <span style={{ color: "#fff", fontSize: 20, fontWeight: 800 }}>FX</span>
            </div>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: "#0f1e36", marginBottom: 8 }}>
              {isChunkError ? "Erreur de chargement" : "Une erreur est survenue"}
            </h1>
            <p style={{ fontSize: 14, color: "#0f1e36", opacity: 0.6, lineHeight: 1.6, marginBottom: 24 }}>
              {isChunkError
                ? "Un module n'a pas pu être chargé. Cela peut arriver après une mise à jour. Essayez de recharger la page."
                : "Quelque chose s'est mal passé. Essayez de recharger la page."}
            </p>
            <button
              onClick={this.handleRetry}
              style={{
                padding: "10px 28px",
                background: "#1d4ed8",
                color: "#fff",
                border: "none",
                borderRadius: 10,
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Recharger
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <RouterProvider router={router} fallbackElement={<GlobalLoader />} />
    </ErrorBoundary>
  );
}
