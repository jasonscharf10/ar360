import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "../auth/[...nextauth]/route";

export async function POST(req: NextRequest) {
  // Auth gate — must be a signed-in @pandadoc.com user
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();

  const res = await fetch("/api/claude", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      //"x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
      // MCP servers require the beta header
      ...(body.mcp_servers?.length ? { "anthropic-beta": "mcp-client-2025-04-04" } : {}),
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok) {
    return NextResponse.json({ error: data.error?.message ?? "Claude error" }, { status: res.status });
  }

  return NextResponse.json(data);
}