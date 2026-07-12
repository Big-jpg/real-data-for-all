import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://perthhousedata.com"),
  title: "Perth House Data",
  description: "Three decades of Perth house sales, open for analysis.",
  alternates: { canonical: "/" },
  openGraph: {
    url: "/",
    title: "Perth House Data",
    description: "Three decades of Perth house sales, open for analysis.",
    images: [{ url: "/og-perth-house-data.png", width: 1536, height: 1024, alt: "Perth House Data open house-sales history" }],
  },
  twitter: { card: "summary_large_image", title: "Perth House Data", description: "Three decades of Perth house sales, open for analysis.", images: ["/og-perth-house-data.png"] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
