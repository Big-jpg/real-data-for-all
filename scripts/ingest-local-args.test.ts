import { describe,expect,it } from "vitest";
import { parseIngestArgs } from "../src/lib/cli";

describe("local ingest arguments",()=>{
  it("ignores pnpm's separator",()=>expect(parseIngestArgs(["--","--limit=1"])).toEqual({directory:"rea_sales_data_model",limit:"1"}));
  it("accepts an explicit directory",()=>expect(parseIngestArgs(["data","--limit=2"])).toEqual({directory:"data",limit:"2"}));
});
