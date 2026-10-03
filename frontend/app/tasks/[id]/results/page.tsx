import type { Metadata } from "next";
import { ResultsPage } from "@/result/results-page";
export const metadata: Metadata = { title: "Task results · reviewWork" };

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ResultsPage taskId={id} />;
}
