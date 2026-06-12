// api/channel3.js
//
// OPTIONAL — only needed if you use the CHANNEL3 or A/B BOTH sourcing backend.
// The default WEB SEARCH backend does not touch this file at all.
//
// The frontend posts either:
//   { action: "image-search", base64_image: "<base64>", limit: 3 }
//   { action: "text-search",  query: "<query>",        limit: 3 }
// and expects { products: [...] } back. This function translates that into a
// Channel3 search call (https://api.trychannel3.com/v1/search) using your
// CHANNEL3_API_KEY, then normalizes the result.
//
// In the app's "PROXY URL" field, enter your deployed origin
// (e.g. https://your-project.vercel.app) — the frontend appends /api/channel3.
//
// Set CHANNEL3_API_KEY in Vercel env vars + your local .env to enable this.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.CHANNEL3_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Server is missing CHANNEL3_API_KEY." });
  }

  const { action, base64_image, query, limit = 3 } = req.body || {};

  // Build the Channel3 search payload. For image search Channel3 takes the
  // raw base64 (no data: prefix); for text search it takes a query string.
  let payload;
  if (action === "image-search") {
    if (!base64_image) return res.status(400).json({ error: "base64_image required" });
    payload = { base64_image, limit };
  } else if (action === "text-search") {
    if (!query) return res.status(400).json({ error: "query required" });
    payload = { query, limit };
  } else {
    return res.status(400).json({ error: "Unknown action" });
  }

  try {
    const upstream = await fetch("https://api.trychannel3.com/v1/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      return res
        .status(upstream.status)
        .json({ error: `Channel3 error ${upstream.status}: ${text.slice(0, 200)}` });
    }

    const raw = await upstream.json();
    // Channel3 may return a bare array or an object — the frontend wants
    // { products: [...] }, so normalize both shapes.
    const products = Array.isArray(raw) ? raw : raw.products || [];
    return res.status(200).json({ products });
  } catch (err) {
    return res.status(502).json({ error: `Upstream request failed: ${err.message}` });
  }
}
