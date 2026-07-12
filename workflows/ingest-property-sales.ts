import { parseSourceCsv, sourceFileHash } from "@/lib/source";

export type IngestRequest = { fileName: string; objectUrl: string; expectedSha256?: string };

export async function ingestPropertySales(input: IngestRequest) {
  "use workflow";
  const registered = await fetchAndRegister(input);
  if (registered.alreadyCurated) return registered;
  await loadRaw(registered.fileId, input.objectUrl);
  await cleanAndCurate(registered.fileId);
  return { fileId: registered.fileId, status: "curated" };
}

async function fetchAndRegister(input: IngestRequest) {
  "use step";
  const response=await fetch(input.objectUrl); if(!response.ok) throw new Error(`Blob download failed: ${response.status}`);
  const content=Buffer.from(await response.arrayBuffer());
  const sha256=sourceFileHash(content);
  if(input.expectedSha256 && input.expectedSha256!==sha256) throw new Error("Source checksum mismatch");
  const { registerFile }=await import("@/lib/db");
  const file=await registerFile(input.fileName,input.objectUrl,sha256,content.byteLength);
  return { fileId:file.fileId, alreadyCurated:file.status==="curated" };
}

async function loadRaw(fileId: string, objectUrl: string) {
  "use step";
  const response=await fetch(objectUrl); if(!response.ok) throw new Error(`Blob download failed: ${response.status}`);
  const rows=parseSourceCsv(Buffer.from(await response.arrayBuffer()));
  const { loadObservations }=await import("@/lib/db");
  return loadObservations(fileId,rows);
}

async function cleanAndCurate(fileId: string) {
  "use step";
  const { curateFile }=await import("@/lib/db"); await curateFile(fileId);
}
