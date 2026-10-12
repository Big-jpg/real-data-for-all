import SalesExplorer from "@/components/SalesExplorer";
import Link from "next/link";

export default function Home() {
  return <main className="app-shell">
    <header className="app-header"><Link className="brand" href="/" aria-label="Perth House Data home"><strong>Perth House Data</strong><span>Sales explorer</span></Link><div className="header-scope"><span>Houses</span><span>6000–6200</span><span>Recorded observations</span></div></header>
    <SalesExplorer />
    <footer className="app-footer"><span>Independent project · Not affiliated with realestate.com.au</span><a href="https://hypecoding.dev" target="_blank" rel="noreferrer">hypecoding.dev ↗</a></footer>
  </main>;
}
