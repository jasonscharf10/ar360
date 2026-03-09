
"use client";
import { signIn } from "next-auth/react";

export default function LoginPage() {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", height: "100vh",
      background: "#0d1117", fontFamily: "Inter, system-ui, sans-serif",
      gap: 24,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: 32 }}>🐼</span>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#21c97a", letterSpacing: 2, textTransform: "uppercase" }}>PandaDoc</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#e2e8f0" }}>AR360</div>
        </div>
      </div>
      <p style={{ color: "#64748b", fontSize: 14, margin: 0 }}>
        Sign in with your PandaDoc Google account to continue.
      </p>
      <button
        onClick={() => signIn("google", { callbackUrl: "/" })}
        style={{
          background: "linear-gradient(135deg,#21c97a,#17a863)",
          border: "none", borderRadius: 10, padding: "12px 28px",
          fontSize: 14, fontWeight: 700, color: "#fff", cursor: "pointer",
        }}
      >
        Sign in with Google
      </button>
    </div>
  );
}