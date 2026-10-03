import type { Metadata } from "next";
import { CreateTaskPage } from "@/create-task/create-task-page";
export const metadata: Metadata = { title: "Create task · reviewWork" };
export default function Page() {
  return <CreateTaskPage />;
}
