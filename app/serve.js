// Tiny static server. The dapp needs http:// rather than file:// because
// wallets refuse to inject into file pages, and fetch() is blocked there too.
//
//   node app/serve.js     →  http://localhost:5173
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const DIR = new URL(".", import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 5173);
const TYPES = { ".html": "text/html", ".json": "application/json", ".js": "text/javascript",
                ".css": "text/css", ".svg": "image/svg+xml" };

createServer(async (req, res) => {
  const path = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  try {
    const body = await readFile(join(DIR, path));
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(PORT, () => {
  console.log(`\n  The Throne → http://localhost:${PORT}\n`);
  console.log("  If it says 'No Throne found', check app/config.json points at");
  console.log("  the right program ID and cluster.\n");
});
