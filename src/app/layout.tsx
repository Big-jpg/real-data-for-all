import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "REA for All",
  description: "Open analytical property-sales data for Perth",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
