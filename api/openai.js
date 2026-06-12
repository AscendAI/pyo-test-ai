// api/openai.js
//
// Serverless proxy for the OpenAI Responses API.
//
// Why this exists: the browser must never hold your OpenAI API key. The
// frontend POSTs the exact request body to this function; the function adds the
// auth header (server-side) and forwards it to api.openai.com, then returns the
// response untouched. The web_search tool the frontend requests runs entirely
// on OpenAI's side, so nothing extra is needed here for it to work.
//
// We use the Responses API (/v1/responses) because it supports both image input
// and the built-in web_search tool with gpt-4o in a single endpoint.
//
// Set OPENAI_API_KEY in your Vercel project (Settings -> Environment Variables)
// and in a local .env file. Runs on Vercel's Node.js runtime, which parses JSON
// bodies into req.body automatically.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: { message: "Method not allowed" } });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: { message: "Server is missing OPENAI_API_KEY." },
    });
  }

  try {
    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(req.body),
    });

    // Pass the OpenAI response straight through, status and all, so the
    // frontend's existing error handling keeps working.
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(502).json({
      error: { message: `Upstream request failed: ${err.message}` },
    });
  }
}
