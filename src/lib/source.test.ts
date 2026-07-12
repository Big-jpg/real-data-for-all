import { describe,expect,it } from "vitest";
import { normaliseAddress,parseSourceCsv,propertyFingerprint } from "./source";

const header="sourceUrl,pageNumber,ordinalOnPage,price,priceValue,address,detailPath,detailUrl,bedrooms,bathrooms,carSpaces,landSize,landSizeSqm,propertyType,soldDate,soldDateISO,scrapedAt";
const row='https://example.test,1,1,"$1,195,000",1195000,"24 Fenchurch Street, Alexander Heights",/sold/property-house-wa-alexander-151308100,https://www.realestate.com.au/sold/property-house-wa-alexander-151308100,4,2,2,578m2,578,House,02 Jul 2026,2026-07-02,2026-07-07T01:52:37.894Z';
describe("source ingestion",()=>{
  it("creates stable observation identity",()=>{const a=parseSourceCsv(Buffer.from(`${header}\n${row}\n`))[0];const b=parseSourceCsv(Buffer.from(`${header}\n${row}\n`))[0];expect(a.observationKey).toBe(b.observationKey);expect(a.values.priceValue).toBe("1195000");});
  it("normalises equivalent address punctuation",()=>{expect(normaliseAddress(" 24 Fenchurch St. ")).toBe("24 FENCHURCH ST");expect(propertyFingerprint("24 Fenchurch St.")).toBe(propertyFingerprint("24  Fenchurch St"));});
});
