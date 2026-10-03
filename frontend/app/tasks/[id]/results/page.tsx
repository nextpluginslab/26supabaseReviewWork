import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { ResultsPage } from "@/result/results-page";
export const metadata: Metadata = { title: "Task results · reviewWork" };

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ funding?: string }>;
}) {
  const { id } = await params;
  const { funding } = await searchParams;
  if (funding === "return" || funding === "cancelled")
    redirect(`/funding#${id}`);
  return <ResultsPage taskId={id} />;
}
