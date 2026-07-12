import SalesExplorer from "@/components/SalesExplorer";
import Link from "next/link";

export default function Home() {
  return (
    <main>
      <header className="hero">
        <Link className="brand" href="/" aria-label="Perth House Data home"><strong>Perth House Data</strong><span>Open sales history</span></Link>
        <p className="eyebrow">30 YEARS · 330 SUBURBS · HOUSES ONLY</p>
        <h1>What did Perth houses<br />really sell for?</h1>
        <p className="lede">Explore three decades of detached-house sales across Perth postcodes 6000–6200—cleaned, deduplicated, and made easy to understand.</p>
        <div className="hero-actions"><a href="#explore">Explore your suburb <span aria-hidden="true">↓</span></a><a href="#methodology">Read the methodology</a></div>
      </header>
      <p className="scope">Houses only <i /> Units excluded <i /> Acreage excluded <i /> Duplex and semi-detached excluded</p>
      <section className="grid">
        <article><strong>347,887</strong><span>source observations</span></article>
        <article><strong>296,422</strong><span>source listings</span></article>
        <article><strong>330</strong><span>house-sale suburbs</span></article>
      </section>
      <p className="status">Neon system of record <i /> MotherDuck OLAP <i /> Vercel Workflow</p>
      <SalesExplorer />
      <footer className="site-footer">
        <div className="footer-intro">
          <p className="eyebrow">BEHIND THE NUMBERS</p>
          <h2>An open dataset,<br />made in the open.</h2>
          <p>This project is as much about the method as the answer. Here is how the records became a public analytical tool—and where it goes next.</p>
        </div>
        <nav className="footer-nav" aria-label="Project information">
          <a href="#data-collection">Collection</a>
          <a href="#analysis">Analysis</a>
          <a href="#methodology">Methodology</a>
          <a href="#implementation">Implementation</a>
          <a href="#reasoning">Reasoning</a>
          <a href="#future-plans">Future plans</a>
        </nav>
        <div className="footer-grid">
          <section id="data-collection"><span>01</span><h3>Data collection</h3><p>358 historical CSV files preserve scraped realestate.com.au sold observations. Each file is registered by checksum and archived before its records move through the pipeline.</p></section>
          <section id="analysis"><span>02</span><h3>Analysis</h3><p>281,196 detached-house sale facts power monthly medians, volumes, bedroom comparisons, and land-to-price relationships across 330 Perth suburbs.</p></section>
          <section id="methodology"><span>03</span><h3>Methodology</h3><p>Addresses are normalised into canonical properties, duplicate listings are resolved, and suburbs receive stable keys. Medians are always recalculated from individual sales—not averaged from aggregates.</p></section>
          <section id="implementation"><span>04</span><h3>Implementation</h3><p>Vercel Workflows orchestrate ingestion, private Blob storage preserves source files, Neon holds canonical records, and MotherDuck serves the analytical layer.</p></section>
          <section id="reasoning"><span>05</span><h3>Reasoning</h3><p>Property history should be inspectable without proprietary desktop tooling. Raw, canonical, and analytical layers remain separate so every result can be traced and challenged.</p></section>
          <section id="future-plans"><span>06</span><h3>Future plans</h3><p>Next steps include stronger parcel-level identity, automated incremental collection, visible quality reporting, richer comparisons, and easier open-data access for independent analysis.</p></section>
        </div>
        <section className="about-builder">
          <div><p className="eyebrow">ABOUT THE BUILDER</p><h2>I make useful things from difficult data.</h2></div>
          <div><p>This is an independent public-interest data project: part engineering experiment, part analytical playground, and part argument for making useful information easier to explore.</p><a href="https://hypecoding.dev" target="_blank" rel="noreferrer">Visit hypecoding.dev <span aria-hidden="true">↗</span></a></div>
        </section>
        <div className="footer-base"><strong>PERTH HOUSE DATA</strong><p>Perth detached-house sales · Postcodes 6000–6200</p><p>Independent project · Not affiliated with realestate.com.au</p></div>
      </footer>
    </main>
  );
}
