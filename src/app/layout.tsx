import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./styles.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://perthhousedata.com"),
  title: { default: "Perth House Data — Sales Explorer", template: "%s | Perth House Data" },
  description: "Explore recorded house-sale prices, monthly volumes and bedroom comparisons across Perth postcodes 6000–6200. Interactive charts and downloadable data.",
  alternates: { canonical: "/" },
  openGraph: {
    url: "/",
    siteName: "Perth House Data",
    type: "website",
    title: "Perth House Data — Sales Explorer",
    description: "Recorded house-sale prices, monthly volumes and bedroom comparisons across Perth postcodes 6000–6200.",
  },
  twitter: { card: "summary_large_image", title: "Perth House Data — Sales Explorer", description: "Interactive charts for recorded Perth house-sale prices and volumes." },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
