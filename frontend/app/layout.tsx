import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "reviewWork",
  description: "Product testing and feedback.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
