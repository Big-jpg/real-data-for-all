import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://real-data-for-all.vercel.app"),
  title: "REA for All",
  description: "Three decades of Perth property sales, open for analysis.",
  openGraph: {
    title: "REA for All",
    description: "Three decades of Perth property sales, open for analysis.",
    images: [{ url: "/og.png", width: 1744, height: 909, alt: "REA for All property analytics" }],
  },
  twitter: { card: "summary_large_image", title: "REA for All", description: "Three decades of Perth property sales, open for analysis.", images: ["/og.png"] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
