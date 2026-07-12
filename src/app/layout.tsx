import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./styles.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://perthhousedata.com"),
  title: { default: "Perth House Data — 30 Years of House Sales", template: "%s | Perth House Data" },
  description: "Explore rolling house-price medians, sales velocity, land relationships and bedroom trends across 330 Perth suburbs. Free, transparent and downloadable.",
  alternates: { canonical: "/" },
  openGraph: {
    url: "/",
    siteName: "Perth House Data",
    type: "website",
    title: "What did Perth houses really sell for?",
    description: "Rolling medians, sales velocity and downloadable house-sale history across 330 Perth suburbs.",
  },
  twitter: { card: "summary_large_image", title: "What did Perth houses really sell for?", description: "Explore 30 years of Perth house sales—free, transparent and downloadable." },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
