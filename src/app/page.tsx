import SalesExplorer from "@/components/SalesExplorer";

export default function Home() {
  return (
    <main>
      <p className="eyebrow">REA FOR ALL · PERTH</p>
      <h1>Property history,<br />open for analysis.</h1>
      <p className="lede">Three decades of Perth property sales, cleaned into canonical properties and opened for independent analysis.</p>
      <section className="grid">
        <article><strong>347,887</strong><span>source observations</span></article>
        <article><strong>296,422</strong><span>source listings</span></article>
        <article><strong>332</strong><span>canonical Perth-area suburbs</span></article>
      </section>
      <p className="status">Neon system of record <i /> MotherDuck OLAP <i /> Vercel Workflow</p>
      <SalesExplorer />
    </main>
  );
}
