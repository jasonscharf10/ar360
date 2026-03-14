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

  const betas: string[] = [];
  if (body.mcp_servers?.length) betas.push("mcp-client-2025-04-04");
  if (body.tools?.some((t: { type?: string }) => t.type?.startsWith("web_search"))) {
    betas.push("web-search-2025-03-05");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": process.env.ANTHROPIC_API_KEY!,
    "anthropic-version": "2023-06-01",
  };
  if (betas.length) headers["anthropic-beta"] = betas.join(",");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok) {
    return NextResponse.json({ error: data.error?.message ?? "Claude error" }, { status: res.status });
  }

  return NextResponse.json(data);
}