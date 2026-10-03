import { CreateTaskPage } from "@/create-task/create-task-page";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <CreateTaskPage editId={id} />;
}
