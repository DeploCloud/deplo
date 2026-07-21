"use client";

/**
 * Global error boundary. It replaces the root layout entirely, so it renders
 * its own <html>/<body> and must NOT use request-time APIs (headers/cookies)
 * that keeps it statically renderable and avoids pulling the nonce-reading root
 * layout into the build's error-page prerender.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#000",
          color: "#ededed",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        }}
      >
        <div style={{ textAlign: "center", padding: "2rem" }}>
          <div
            style={{
              width: 0,
              height: 0,
              margin: "0 auto 1.5rem",
              borderLeft: "12px solid transparent",
              borderRight: "12px solid transparent",
              borderTop: "20px solid #ededed",
            }}
          />
          <h1 style={{ fontSize: "1.25rem", fontWeight: 600, margin: 0 }}>
            Something went wrong
          </h1>
          <p
            style={{
              color: "#a1a1aa",
              marginTop: "0.5rem",
              fontSize: "0.875rem",
            }}
          >
            An unexpected error occurred.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: "1.5rem",
              cursor: "pointer",
              background: "#ededed",
              color: "#0a0a0a",
              border: "none",
              borderRadius: "0.5rem",
              padding: "0.5rem 1rem",
              fontSize: "0.875rem",
              fontWeight: 500,
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
