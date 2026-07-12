export function parseIngestArgs(argv: string[]) {
  const args=argv.filter((value)=>value!=="--");
  return {
    directory:args.find((value)=>!value.startsWith("--"))||"rea_sales_data_model",
    limit:args.find((value)=>value.startsWith("--limit="))?.split("=")[1],
  };
}
