import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://real-data-for-all.vercel.app"),
  title: "REA for All",
  description: "Three decades of Perth house sales, open for analysis.",
  openGraph: {
    title: "REA for All",
    description: "Three decades of Perth house sales, open for analysis.",
    images: [{ url: "/og-warm.png", width: 1536, height: 1024, alt: "REA for All Perth house-sales analytics" }],
  },
  twitter: { card: "summary_large_image", title: "REA for All", description: "Three decades of Perth house sales, open for analysis.", images: ["/og-warm.png"] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
