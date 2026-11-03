"use client";

import { useEffect } from "react";
import { recoverableError, reloadWhenBack } from "@/lib/stale-build";

export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const recoverable = recoverableError(error);
  const stale = recoverable === "stale";
  useEffect(() => {
    if (recoverable) return reloadWhenBack();
  }, [recoverable]);

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
            {stale
              ? "Deplo was updated"
              : recoverable
                ? "Connection interrupted"
                : "Something went wrong"}
          </h1>
          <p
            style={{
              color: "#a1a1aa",
              marginTop: "0.5rem",
              fontSize: "0.875rem",
            }}
          >
            {stale
              ? "This tab is still running the previous version. Reloading picks up the new one."
              : recoverable
                ? "The page stopped loading halfway. Reloading picks it up again."
                : "An unexpected error occurred."}
          </p>
          <button
            type="button"
            onClick={
              recoverable ? () => window.location.reload() : () => retry()
            }
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
            {recoverable ? "Reload" : "Try again"}
          </button>
        </div>
      </body>
    </html>
  );
}
