import { createRequire } from "node:module";
import fs, { mkdir } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const esbuild = require(require.resolve("esbuild", { paths: [require.resolve("tsx")] }));
const runtimeDirectory = path.resolve("captures/_runtime");
await mkdir(runtimeDirectory, { recursive: true });
const output = path.join(runtimeDirectory, "rea-listing-capture.mjs");
await esbuild.build({ entryPoints: ["src/lib/rea-listing-capture.ts"], outfile: output, bundle: true, platform: "node", format: "esm", target: "node22" });

// The CUA runtime already exposes these native handles. This static build bridges
// imports to those handles without file imports, runtime require or generated code.
const boundBuiltins = {
  "node:fs/promises": "export default captureFiles;",
  "node:path": "export default capturePath;",
  "node:crypto": "export const createHash = collectorCrypto.createHash;",
};
const bridgePlugin = {
  name: "cua-native-handles",
  setup(build) {
    build.onResolve({ filter: /^node:/ }, (args) => {
      if (!(args.path in boundBuiltins)) throw new Error(`Unsupported CUA native import: ${args.path}`);
      return { path: args.path, namespace: "cua-native-handles" };
    });
    build.onLoad({ filter: /.*/, namespace: "cua-native-handles" }, (args) => ({ contents: boundBuiltins[args.path], loader: "js" }));
  },
};
const bundleOptions = {
  bundle: true, write: false, platform: "node", format: "iife", target: "es2022",
  // Namespace and exported API names remain readable; internal bindings shrink the paste payload.
  plugins: [bridgePlugin], minifySyntax: true, minifyWhitespace: true, minifyIdentifiers: true,
  legalComments: "none",
};
const core = await esbuild.build({ ...bundleOptions, entryPoints: ["src/lib/rea-listing-capture.ts"], globalName: "collectorCore" });
const collector = await esbuild.build({ ...bundleOptions, entryPoints: ["scripts/chrome-listing-collector.mjs"], globalName: "collectorModule" });
const bootstrap = `${core.outputFiles[0].text}\n${collector.outputFiles[0].text}\n`;

// Executing a built artifact here is a local verification step, never a CUA API action.
const verification = vm.createContext({ captureFiles: fs, capturePath: path, collectorCrypto: crypto, URL, Buffer, setTimeout, clearTimeout });
new vm.Script(bootstrap, { filename: "chrome-collector-bootstrap.js" }).runInContext(verification);
if (typeof verification.collectorCore?.adaptListingPage !== "function" || typeof verification.collectorModule?.createChromeCollector !== "function") {
  throw new Error("CUA bootstrap did not expose both collector namespaces");
}
const expectedUrl = "https://www.realestate.com.au/sold/property-house-in-hocking,+wa+6065/list-2?includeSurrounding=false&maxSoldAge=6-month&activeSort=solddate";
if (verification.collectorModule.listingUrl({ suburb: "Hocking", postcode: "6065" }, 2) !== expectedUrl || verification.collectorCore.disclosedPriceValue("$1,100,000") !== "1100000") {
  throw new Error("CUA bootstrap export smoke checks failed");
}
const bootstrapPath = path.join(runtimeDirectory, "chrome-collector-bootstrap.js");
await fs.writeFile(bootstrapPath, bootstrap, "utf8");
console.log(JSON.stringify({ coreModule: output, bootstrap: bootstrapPath, characters: bootstrap.length, bytes: Buffer.byteLength(bootstrap), verification: "passed" }));
