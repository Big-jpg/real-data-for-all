// content.js — REA Sold Scraper Content Script
// Injected on realestate.com.au pages. Listens for messages from background worker.

(() => {
  "use strict";

  const text = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();

  // Strip superscript characters (², ³, etc.) → plain digits
  const stripSuperscripts = (s) => {
    if (s == null) return null;
    return String(s)
      .replace(/²/g, "2")
      .replace(/³/g, "3")
      .replace(/[\u00B2\u00B3\u2070-\u209F]/g, (ch) => {
        const map = {
          "\u00B2": "2", "\u00B3": "3",
          "\u2070": "0", "\u00B9": "1", "\u2074": "4",
          "\u2075": "5", "\u2076": "6", "\u2077": "7",
          "\u2078": "8", "\u2079": "9"
        };
        return map[ch] || "";
      });
  };

  // Parse a single numeric value from a string (strip non-digit/dot)
  const parseSingleNumber = (value) => {
    if (value == null) return null;
    const cleaned = String(value).replace(/[^\d.]/g, "");
    if (!cleaned) return null;
    const n = Number(cleaned);
    return isNaN(n) ? null : n;
  };

  // Detect price range and return midpoint, or single value
  const parsePriceValue = (rawPrice) => {
    if (rawPrice == null || rawPrice === "") return null;
    const s = String(rawPrice);
    const rangeMatch = s.match(/\$\s*([\d,]+(?:\.\d+)?)\s*[-–—]\s*\$\s*([\d,]+(?:\.\d+)?)/);
    if (rangeMatch) {
      const low = parseSingleNumber(rangeMatch[1]);
      const high = parseSingleNumber(rangeMatch[2]);
      if (low != null && high != null) return Math.round((low + high) / 2);
    }
    const rangeMatch2 = s.match(/range\s*:?\s*([\d,]+(?:\.\d+)?)\s*[-–—]\s*([\d,]+(?:\.\d+)?)/i);
    if (rangeMatch2) {
      const low = parseSingleNumber(rangeMatch2[1]);
      const high = parseSingleNumber(rangeMatch2[2]);
      if (low != null && high != null) return Math.round((low + high) / 2);
    }
    return parseSingleNumber(s);
  };

  const absoluteUrl = (href, baseUrl) => {
    if (!href) return null;
    try { return new URL(href, baseUrl).href; } catch { return href; }
  };

  // Parse sold date text into ISO format (YYYY-MM-DD)
  const parseSoldDateISO = (rawDate) => {
    if (!rawDate) return null;
    const months = {
      jan: "01", january: "01", feb: "02", february: "02",
      mar: "03", march: "03",   apr: "04", april: "04",
      may: "05",                jun: "06", june: "06",
      jul: "07", july: "07",   aug: "08", august: "08",
      sep: "09", september: "09", oct: "10", october: "10",
      nov: "11", november: "11", dec: "12", december: "12"
    };
    const match = rawDate.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
    if (!match) return null;
    const day = match[1].padStart(2, "0");
    const month = months[match[2].toLowerCase()];
    if (!month) return null;
    return `${match[3]}-${month}-${day}`;
  };

  const parsePrimaryAttributes = (card) => {
    const primary = card.querySelector("ul.residential-card__primary");
    const aria = primary?.getAttribute("aria-label") || "";
    const bed  = aria.match(/(\d+)\s+bedrooms?/i);
    const bath = aria.match(/(\d+)\s+bathrooms?/i);
    const car  = aria.match(/(\d+)\s+car spaces?/i);
    const land = aria.match(/([\d,.]+)\s*m[²2]\s+land size/i);
    const type = aria.match(/^(.+?)\s+with\b/i);
    return {
      bedrooms:    bed  ? Number(bed[1])              : null,
      bathrooms:   bath ? Number(bath[1])             : null,
      carSpaces:   car  ? Number(car[1])              : null,
      landSize:    land ? `${land[1]}m2`              : null,
      landSizeSqm: land ? parseSingleNumber(land[1])  : null,
      propertyType: type ? type[1].trim()             : null
    };
  };

  const parseSoldDate = (card) => {
    const soldText = [...card.querySelectorAll("span, p, div")]
      .map(text)
      .find(v => /^Sold on\s+/i.test(v));
    return soldText ? soldText.replace(/^Sold on\s+/i, "").trim() : null;
  };

  // Normalize a record: type-safe fields, trimmed strings, strip superscripts
  const normalizeRecord = (r) => {
    const numOrNull = (v) => { if (v == null) return null; const n = Number(v); return isNaN(n) ? null : n; };
    const trimOrNull = (v) => { if (v == null) return null; const s = String(v).trim(); return s === "" ? null : s; };
    return {
      sourceUrl:     trimOrNull(r.sourceUrl),
      pageNumber:    numOrNull(r.pageNumber),
      ordinalOnPage: numOrNull(r.ordinalOnPage),
      matchType:     trimOrNull(r.matchType),   // "exact" | "surrounding"
      price:         trimOrNull(r.price),
      priceValue:    numOrNull(r.priceValue),
      address:       trimOrNull(r.address),
      detailPath:    trimOrNull(r.detailPath),
      detailUrl:     trimOrNull(r.detailUrl),
      bedrooms:      numOrNull(r.bedrooms),
      bathrooms:     numOrNull(r.bathrooms),
      carSpaces:     numOrNull(r.carSpaces),
      landSize:      trimOrNull(stripSuperscripts(r.landSize)),
      landSizeSqm:   numOrNull(r.landSizeSqm),
      propertyType:  trimOrNull(r.propertyType),
      soldDate:      trimOrNull(r.soldDate),
      soldDateISO:   parseSoldDateISO(r.soldDate),
      scrapedAt:     r.scrapedAt
    };
  };

  const isValidRecord = (r) => !!(r.address || r.detailUrl);

  const parseCard = (card, pageNumber, sourceUrl, ordinalOnPage, matchType) => {
    const link      = card.querySelector("a.residential-card__details-link") || card.querySelector('a[href*="/sold/property-"]');
    const priceText = text(card.querySelector(".property-price"));
    const attrs     = parsePrimaryAttributes(card);
    const detailPath = link?.getAttribute("href") || null;
    const detailUrl  = absoluteUrl(detailPath, sourceUrl);
    const raw = {
      sourceUrl, pageNumber, ordinalOnPage, matchType,
      price:        priceText || null,
      priceValue:   parsePriceValue(priceText),
      address:      text(link?.querySelector("span")) || text(link) || null,
      detailPath, detailUrl,
      bedrooms:     attrs.bedrooms,
      bathrooms:    attrs.bathrooms,
      carSpaces:    attrs.carSpaces,
      landSize:     attrs.landSize,
      landSizeSqm:  attrs.landSizeSqm,
      propertyType: attrs.propertyType,
      soldDate:     parseSoldDate(card),
      scrapedAt:    new Date().toISOString()
    };
    return normalizeRecord(raw);
  };

  // ── Card extraction with dual-tier support ────────────────────────────────
  // Returns [{card, matchType}] from both exact and surrounding result tiers.
  const getCardEntries = (doc) => {
    const entries = [];

    // Tier 1: exact suburb matches
    const exactList =
      doc.querySelector(".results-page .tiered-results-container ul.tiered-results.tiered-results--exact") ||
      doc.querySelector("ul.tiered-results.tiered-results--exact");

    if (exactList) {
      exactList.querySelectorAll("div.residential-card__content").forEach(card => {
        entries.push({ card, matchType: "exact" });
      });
    }

    // Tier 2: surrounding suburb matches
    const surroundingList =
      doc.querySelector(".results-page .tiered-results-container ul.tiered-results.tiered-results--surrounding") ||
      doc.querySelector("ul.tiered-results.tiered-results--surrounding");

    if (surroundingList) {
      surroundingList.querySelectorAll("div.residential-card__content").forEach(card => {
        entries.push({ card, matchType: "surrounding" });
      });
    }

    // Fallback: if neither tier container found, grab all cards in document
    if (entries.length === 0) {
      doc.querySelectorAll("div.residential-card__content").forEach(card => {
        entries.push({ card, matchType: "exact" }); // assume exact when structure unknown
      });
    }

    return entries;
  };

  // ── Total results count parsing ───────────────────────────────────────────
  // Parses "Showing 1-25 of 258 properties" or "1-25 of 258 results" etc.
  // Returns the total count as a number, or null if not found.
  const parseTotalResults = (doc) => {
    // Try common REA result-count selectors
    const candidates = [
      doc.querySelector("[data-testid='results-count']"),
      doc.querySelector(".results-count"),
      doc.querySelector(".total-results"),
      doc.querySelector("h1.results-header__title"),
      doc.querySelector("[class*='results-header']"),
      doc.querySelector("[class*='result-count']"),
      doc.querySelector("[class*='resultsCount']"),
    ].filter(Boolean);

    // Also search all text nodes for the pattern
    const allText = doc.body ? doc.body.innerText || doc.body.textContent : "";

    // Pattern: "X - Y of Z properties" or "X-Y of Z" or "Showing X of Z"
    const patterns = [
      /\b(\d[\d,]*)\s+(?:properties|results|homes?|listings?)\b/i,
      /\bof\s+(\d[\d,]*)\s+(?:properties|results|homes?|listings?)\b/i,
      /\bShowing\s+\d[\d,]*\s*[-–]\s*\d[\d,]*\s+of\s+(\d[\d,]*)/i,
      /\b(\d[\d,]*)\s+sold\b/i,
    ];

    // Check candidate elements first
    for (const el of candidates) {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      for (const pat of patterns) {
        const m = t.match(pat);
        if (m) {
          const n = parseInt(m[1].replace(/,/g, ""), 10);
          if (!isNaN(n) && n > 0) return n;
        }
      }
    }

    // Fallback: scan full page text
    for (const pat of patterns) {
      const m = allText.match(pat);
      if (m) {
        const n = parseInt(m[1].replace(/,/g, ""), 10);
        if (!isNaN(n) && n > 0) return n;
      }
    }

    return null;
  };

  // ── Fetch ─────────────────────────────────────────────────────────────────
  // Returns { doc } on success, { rateLimited: true } on 429, throws on other errors.
  const fetchAndParse = async (pageUrl, retries, retryDelayMs) => {
    let lastError = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
      const url = new URL(pageUrl);
      url.searchParams.set("_scrape_ts", String(Date.now()));
      try {
        const response = await fetch(url.href, {
          method: "GET",
          credentials: "include",
          cache: "reload",
          headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }
        });
        if (response.status === 429) return { rateLimited: true };
        if (!response.ok) throw new Error(`Fetch failed ${response.status}`);
        const html = await response.text();
        if (!html || html.length < 1000) throw new Error("Suspiciously small HTML");
        const doc = new DOMParser().parseFromString(html, "text/html");
        return { doc };
      } catch (err) {
        lastError = err;
        if (attempt < retries) await new Promise(r => setTimeout(r, retryDelayMs * attempt));
      }
    }
    throw lastError;
  };

  // ── Message handler ───────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== "EXTRACT_PAGE") return false;

    const { pageUrl, pageNumber, retries, retryDelayMs } = message;

    (async () => {
      try {
        const result = await fetchAndParse(pageUrl, retries || 3, retryDelayMs || 2500);

        if (result.rateLimited) {
          sendResponse({ success: true, rateLimited: true, records: [], empty: false });
          return;
        }

        const { doc } = result;
        const cardEntries = getCardEntries(doc);

        // On page 1, also parse the total results count
        const totalResults = (pageNumber === 1) ? parseTotalResults(doc) : undefined;

        if (cardEntries.length === 0) {
          sendResponse({ success: true, records: [], empty: true, totalResults });
          return;
        }

        let ordinal = 1;
        const records = cardEntries
          .map(({ card, matchType }) => parseCard(card, pageNumber, pageUrl, ordinal++, matchType))
          .filter(isValidRecord);

        sendResponse({ success: true, records, empty: records.length === 0, totalResults });
      } catch (err) {
        sendResponse({ success: false, error: err.message || String(err) });
      }
    })();

    return true;
  });
})();
