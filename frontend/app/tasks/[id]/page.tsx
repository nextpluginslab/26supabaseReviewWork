import { TaskPage } from "@/task/task-page";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <TaskPage key={id} taskId={id} />;
}
