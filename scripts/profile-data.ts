import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseSourceCsv } from "../src/lib/source";

const directory=path.resolve(process.argv[2]||"rea_sales_data_model");
const files=(await readdir(directory)).filter((f)=>f.endsWith(".csv"));
let rows=0,bytes=0,missingAddress=0,missingPrice=0,minDate="9999-99-99",maxDate="";const observations=new Set<string>();
for(const file of files){const content=await readFile(path.join(directory,file));bytes+=content.byteLength;for(const parsed of parseSourceCsv(content)){const v=parsed.values;rows++;observations.add(parsed.observationKey);if(!v.address)missingAddress++;if(!v.priceValue)missingPrice++;if(v.soldDateISO){minDate=v.soldDateISO<minDate?v.soldDateISO:minDate;maxDate=v.soldDateISO>maxDate?v.soldDateISO:maxDate;}}}
console.log(JSON.stringify({files:files.length,bytes,sourceRows:rows,uniqueObservations:observations.size,duplicateObservations:rows-observations.size,missingAddress,missingPrice,minDate,maxDate},null,2));
