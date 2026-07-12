import { describe,expect,it } from "vitest";

function parseArgs(argv: string[]) {
  const args=argv.filter((value)=>value!=="--");
  return {
    directory:args.find((value)=>!value.startsWith("--"))||"rea_sales_data_model",
    limit:args.find((value)=>value.startsWith("--limit="))?.split("=")[1],
  };
}

describe("local ingest arguments",()=>{
  it("ignores pnpm's separator",()=>expect(parseArgs(["--","--limit=1"])).toEqual({directory:"rea_sales_data_model",limit:"1"}));
  it("accepts an explicit directory",()=>expect(parseArgs(["data","--limit=2"])).toEqual({directory:"data",limit:"2"}));
});
