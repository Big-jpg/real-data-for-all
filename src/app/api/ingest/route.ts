import { start } from "workflow/api";
import { z } from "zod";
import { ingestPropertySales } from "../../../../workflows/ingest-property-sales";

const bodySchema=z.object({fileName:z.string().min(1),objectUrl:z.url(),expectedSha256:z.string().length(64).optional()});
export async function POST(request: Request) {
  if(request.headers.get("authorization")!==`Bearer ${process.env.INGEST_SECRET}`) return Response.json({error:"Unauthorized"},{status:401});
  const parsed=bodySchema.safeParse(await request.json());
  if(!parsed.success) return Response.json({error:parsed.error.flatten()},{status:400});
  const run=await start(ingestPropertySales,[parsed.data]);
  return Response.json({runId:run.runId,status:"accepted"},{status:202});
}
