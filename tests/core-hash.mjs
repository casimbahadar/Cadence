/* Prints CORE's byte length and sha256. CORE is shared byte-for-byte with
   Cadence Heroes, so this is how each side proves its copy matches after a
   change inside the markers. */
import { readFileSync } from "fs";
import { createHash } from "crypto";
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const m = html.match(/\/\* CORE-START \*\/([\s\S]*?)\/\* CORE-END \*\//);
if (!m) { console.error("CORE markers not found"); process.exit(1); }
console.log(m[1].length + " bytes  sha256 " + createHash("sha256").update(m[1]).digest("hex"));
