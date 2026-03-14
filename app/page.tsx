import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "./api/auth/[...nextauth]/route";
import AR360 from "@/components/AR360";

export default async function Home() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");

  return <AR360 user={session.user} />;
}