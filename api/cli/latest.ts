import { handleCliDownload } from "../../src/handlers.js";

// GET /api/cli/latest — the CLI tarball, for any holder of a valid engineer key.
//
// The key is read from the `x-edge8-key` HEADER only, never a query parameter.
// `?key=` would make `npm i -g <url>` a true one-liner, but request URLs land in
// the platform's access logs, so every download would write a live credential
// into log retention where nobody would think to look for one. A header costs
// one extra command and leaks nothing.
export default async function handler(req: any, res: any) {
  if (req.method !== "GET" && req.method !== "HEAD") return res.status(405).end();

  const r = await handleCliDownload(String(req.headers["x-edge8-key"] ?? ""));

  for (const [k, v] of Object.entries(r.headers ?? {})) res.setHeader(k, v);
  if (r.bytes) return res.status(r.status).send(Buffer.from(r.bytes));
  res.status(r.status).json(r.json ?? {});
}
