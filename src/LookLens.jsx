import { useState, useRef } from "react";

// ============================================================
// LOOKLENS — shop-the-look prototype (v0.2)
// Pipeline: upload photo → VLM detects garments (+ approx
// bounding boxes) → client-side crop per item → SOURCING via
// pluggable backends:
//   [web] GPT-5.5 + live web search
//   [c3]  Channel3 catalog image-search (api.trychannel3.com)
//   [ab]  A/B — run both, compare side by side
// ============================================================

// Calls go through our own serverless function (api/openai.js), which holds
// the OPENAI_API_KEY server-side. Never call api.openai.com directly
// from the browser — it has no key and would expose it if it did.
const API_URL = "/api/openai";
const MODEL = "gpt-5.5";
// Proxy endpoint — single URL for both image and text search.
// Default is empty, which resolves to this app's own co-deployed serverless
// function at /api/channel3 (works on Vercel prod and with `vercel dev`).
// Enter a full origin (e.g. https://your-project.vercel.app) to point at a
// different deployment, or a full endpoint URL for a custom proxy.
const DEFAULT_PROXY_URL = "";
const getC3ProxyUrl = (proxy) => {
  const p = (proxy || "").trim().replace(/\/+$/, "");
  // Empty → use the serverless function co-deployed with this app (same origin).
  if (!p) return "/api/channel3";
  // A bare origin with no path → append the serverless route.
  if (/^https?:\/\/[^/]+$/.test(p)) return `${p}/api/channel3`;
  // Otherwise assume a full endpoint URL and use it as-is.
  return p;
};

const C = {
  bg: "#F4F4F2",
  surface: "#FFFFFF",
  ink: "#131312",
  muted: "#71716C",
  line: "#DEDEDA",
  accent: "#2B3CDB",
  danger: "#B42318",
};

const BACKENDS = {
  web: { label: "WEB SEARCH" },
  c3: { label: "CHANNEL3" },
};

const DETECT_PROMPT = `You are the detection stage of a fashion visual-search system. Analyze this photo of an outfit.

Identify each distinct visible clothing item and accessory (headwear, tops, outerwear, bottoms, footwear, bags, eyewear, watches, jewelry).

Respond with ONLY valid JSON — no markdown fences, no commentary — exactly this shape:
{"items":[{"type":"","color":"","brand":null,"description":"","search_query":"","bbox":{"x":0,"y":0,"w":0,"h":0}}]}

Rules:
- "type": short category, e.g. "cap", "t-shirt", "overshirt", "jeans", "sneakers"
- "color": main color(s), concise, e.g. "maroon", "washed black"
- "brand": brand name ONLY if a logo, lockup, or unmistakable signature design is clearly visible; otherwise null. Never guess.
- "description": ONE concise sentence covering fit, material, pattern, notable details
- "search_query": the shopping search query most likely to surface this exact product online (brand + model words if known, otherwise precise descriptive terms)
- "bbox": approximate bounding box as PERCENTAGES (0-100) of image width/height; x,y = top-left corner
- Maximum 6 items. Skip items that are barely visible or too uncertain.`;

function buildSearchPrompt(item) {
  return `You are the sourcing stage of a fashion visual-search system, with live web search.

Find purchasable online listings for this item seen in a photo:
- Type: ${item.type}
- Color: ${item.color}
- Brand (if detected): ${item.brand || "unknown"}
- Details: ${item.description}
- Suggested query: "${item.search_query}"

Search the web. Return up to 3 product listings, prioritised:
1. Exact brand + model matches
2. Very close alternatives from reputable retailers (brand stores, Amazon, ASOS, Zalando, Farfetch, END., SSENSE, etc.)

Only include URLs that actually appeared in your search results — never fabricate a URL. Prefer direct product pages over category pages.

Respond with ONLY valid JSON, no markdown:
{"matches":[{"product_name":"","retailer":"","url":"","price":null,"match_type":"exact","note":""}]}
- "match_type": "exact" or "similar"
- "price": display string like "$45" or null if unknown
- "note": max 8 words on why it matches
If nothing credible is found, return {"matches":[]}.`;
}

// ---------------- generic helpers ----------------

async function callOpenAI(body) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `API error ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error?.message) msg = j.error.message;
    } catch (e) {}
    throw new Error(msg);
  }
  return res.json();
}

// Pull the assistant's text out of an OpenAI Responses API result. The raw
// response exposes an aggregated `output_text`, but we also walk `output[]` and
// concat every `output_text` content part as a fallback (web_search runs add
// non-message items to that array, which we simply skip).
function textOf(data) {
  if (typeof data.output_text === "string" && data.output_text) {
    return data.output_text;
  }
  return (data.output || [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content || [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text)
    .join("\n");
}

function extractJSON(text) {
  const cleaned = (text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  if (!cleaned) throw new Error("Empty response (likely truncated — try RETRY)");
  const s = cleaned.indexOf("{");
  const e = cleaned.lastIndexOf("}");
  if (s === -1 || e === -1 || e <= s) throw new Error("No JSON in response");
  return JSON.parse(cleaned.slice(s, e + 1));
}

function validBbox(b) {
  if (!b || typeof b !== "object") return null;
  const n = (v) => (typeof v === "number" && isFinite(v) ? v : NaN);
  let x = n(b.x), y = n(b.y), w = n(b.w), h = n(b.h);
  if ([x, y, w, h].some(isNaN)) return null;
  x = Math.max(0, Math.min(99, x));
  y = Math.max(0, Math.min(99, y));
  w = Math.max(0, Math.min(100 - x, w));
  h = Math.max(0, Math.min(100 - y, h));
  if (w < 2 || h < 2) return null;
  return { x, y, w, h };
}

const readAndResize = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const MAX = 1100;
        const scale = Math.min(1, MAX / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => reject(new Error("Could not read image"));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });

const cropFromDataUrl = (dataUrl, bbox) =>
  new Promise((resolve) => {
    if (!bbox) return resolve(null);
    const img = new Image();
    img.onload = () => {
      const pad = 4; // % padding around the box
      const x = Math.max(0, bbox.x - pad);
      const y = Math.max(0, bbox.y - pad);
      const w = Math.min(100 - x, bbox.w + pad * 2);
      const h = Math.min(100 - y, bbox.h + pad * 2);
      const sx = (x / 100) * img.naturalWidth;
      const sy = (y / 100) * img.naturalHeight;
      const sw = (w / 100) * img.naturalWidth;
      const sh = (h / 100) * img.naturalHeight;
      if (sw < 4 || sh < 4) return resolve(null);
      const T = 320;
      const sc = Math.min(1, T / Math.max(sw, sh));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(sw * sc));
      canvas.height = Math.max(1, Math.round(sh * sc));
      canvas
        .getContext("2d")
        .drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });

const pad2 = (n) => String(n).padStart(2, "0");

// ---------------- Channel3 helpers ----------------

const CUR_SYM = { USD: "$", EUR: "€", GBP: "£", CAD: "C$", AUD: "A$" };

function fmtPrice(p) {
  if (!p || typeof p.price !== "number") return null;
  const sym = CUR_SYM[p.currency] || (p.currency ? p.currency + " " : "");
  return `${sym}${p.price}`;
}

// Proxy fetch — API key stays server-side
async function proxyFetch(url, body) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`Network error: ${e.message} — is proxy running?`);
  }
  if (!res.ok) {
    let msg = `Proxy error ${res.status}`;
    try {
      const j = await res.json();
      if (typeof j?.error === "string") msg = j.error;
    } catch (e) {}
    throw new Error(msg);
  }
  return res.json();
}

// Map Channel3 Product objects → LookLens match shape.
// EXACT label is a heuristic: detected brand matches product brand.
function mapC3Products(products, detectedBrand) {
  return (products || [])
    .slice(0, 3)
    .map((p) => {
      const offers = [...(p.offers || [])].sort((a, b) => {
        const ai = a.availability === "InStock" ? 0 : 1;
        const bi = b.availability === "InStock" ? 0 : 1;
        if (ai !== bi) return ai - bi;
        const ap = a.price && typeof a.price.price === "number" ? a.price.price : Infinity;
        const bp = b.price && typeof b.price.price === "number" ? b.price.price : Infinity;
        return ap - bp;
      });
      const o = offers[0];
      const brandNames = (p.brands || []).map((b) => b.name).filter(Boolean);
      const db = (detectedBrand || "").trim().toLowerCase();
      const exact =
        db.length > 0 &&
        brandNames.some((n) => {
          const bn = n.toLowerCase();
          return bn.includes(db) || db.includes(bn);
        });
      const main = (p.images || []).find((i) => i.is_main_image) || (p.images || [])[0];
      const noteBits = [];
      if (brandNames[0]) noteBits.push(brandNames[0]);
      if (o && o.availability && o.availability !== "InStock") noteBits.push(o.availability);
      return {
        product_name: p.title,
        retailer: o ? o.domain : brandNames[0] || "channel3",
        url: o ? o.url : null,
        price: o ? fmtPrice(o.price) : null,
        match_type: exact ? "exact" : "similar",
        note: noteBits.join(" · "),
        image: main ? main.url : null,
      };
    })
    .filter((m) => m.url);
}

// ---------------- tiny components ----------------

const Spinner = ({ color = C.accent }) => (
  <span
    className="ll-spin inline-block w-3 h-3 rounded-full shrink-0"
    style={{ border: `2px solid ${color}`, borderTopColor: "transparent" }}
  />
);

const HangerIcon = (props) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    <path d="M12 7.5c0-1 .8-1.2 1.3-1.6a2.1 2.1 0 1 0-3.4-1.7" />
    <path d="M12 7.5 3.9 13.5a1.8 1.8 0 0 0 1.1 3.3h14a1.8 1.8 0 0 0 1.1-3.3L12 7.5Z" />
  </svg>
);

const ArrowIcon = (props) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    <path d="M7 17 17 7M9 7h8v8" />
  </svg>
);

const CropFrame = ({ children }) => (
  <div className="relative p-2">
    {[
      { top: 0, left: 0, borderTop: `1.5px solid ${C.ink}`, borderLeft: `1.5px solid ${C.ink}` },
      { top: 0, right: 0, borderTop: `1.5px solid ${C.ink}`, borderRight: `1.5px solid ${C.ink}` },
      { bottom: 0, left: 0, borderBottom: `1.5px solid ${C.ink}`, borderLeft: `1.5px solid ${C.ink}` },
      { bottom: 0, right: 0, borderBottom: `1.5px solid ${C.ink}`, borderRight: `1.5px solid ${C.ink}` },
    ].map((s, i) => (
      <div key={i} className="absolute w-3 h-3" style={s} aria-hidden="true" />
    ))}
    {children}
  </div>
);

const Badge = ({ type }) =>
  type === "exact" ? (
    <span
      className="ll-mono px-1.5 py-0.5 shrink-0"
      style={{ background: C.accent, color: "#fff", fontSize: 10 }}
    >
      EXACT
    </span>
  ) : (
    <span
      className="ll-mono px-1.5 py-0.5 shrink-0"
      style={{ border: `1px solid ${C.line}`, color: C.muted, fontSize: 10 }}
    >
      SIMILAR
    </span>
  );

// ---------------- main ----------------

const emptySrc = () => ({
  web: { status: "idle", matches: [], error: null },
  c3: { status: "idle", matches: [], error: null },
});

export default function LookLens() {
  const [imgDataUrl, setImgDataUrl] = useState(null);
  const [phase, setPhase] = useState("idle"); // idle | ready | detecting | searching | done
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [backend, setBackend] = useState("web"); // web | c3 | ab
  const [proxyUrl, setProxyUrl] = useState(DEFAULT_PROXY_URL);
  const fileRef = useRef(null);

  const working = phase === "detecting" || phase === "searching";
  const active = backend === "ab" ? ["web", "c3"] : [backend];
  const needsC3 = backend !== "web";

  const totalLinks = items.reduce(
    (n, it) => n + active.reduce((m, b) => m + it.src[b].matches.length, 0),
    0
  );
  const finished = items.filter((it) =>
    active.every((b) => it.src[b].status === "done" || it.src[b].status === "failed")
  ).length;

  const updateSrc = (id, b, patch) =>
    setItems((prev) =>
      prev.map((it) =>
        it.id === id ? { ...it, src: { ...it.src, [b]: { ...it.src[b], ...patch } } } : it
      )
    );

  const handleFiles = async (fileList) => {
    const file = fileList && fileList[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("That file is not an image. Use a JPG or PNG.");
      return;
    }
    setError(null);
    try {
      const dataUrl = await readAndResize(file);
      setImgDataUrl(dataUrl);
      setItems([]);
      setPhase("ready");
    } catch (e) {
      setError(e.message);
    }
  };

  // -------- backend runners --------

  const searchWeb = async (it) => {
    const data = await callOpenAI({
      // web_search reasoning + results share this budget, so keep it generous —
      // too low and the model runs out of room before emitting the final JSON.
      model: MODEL,
      max_output_tokens: 3000,
      input: [{ role: "user", content: buildSearchPrompt(it) }],
      tools: [{ type: "web_search" }],
    });
    const parsed = extractJSON(textOf(data));
    return (parsed.matches || [])
      .filter((m) => m && m.url)
      .slice(0, 3)
      .map((m) => ({ ...m, image: null }));
  };

  const searchC3 = async (it) => {
    // Empty proxyUrl is valid — getC3ProxyUrl resolves it to this app's
    // co-deployed /api/channel3 serverless function (same origin).
    const endpoint = getC3ProxyUrl(proxyUrl);
    let data;
    if (it.thumb) {
      // Cropped garment → image search. Base64 WITHOUT the data URI prefix.
      const base64 = it.thumb.split(",")[1];
      data = await proxyFetch(endpoint, { action: "image-search", base64_image: base64, limit: 3 });
    } else {
      // No crop available → text search on the generated query.
      data = await proxyFetch(endpoint, { action: "text-search", query: it.search_query, limit: 3 });
    }
    return mapC3Products(data.products, it.brand);
  };

  const runBackend = async (it, b) => {
    updateSrc(it.id, b, { status: "searching", error: null });
    try {
      const matches = b === "web" ? await searchWeb(it) : await searchC3(it);
      updateSrc(it.id, b, { status: "done", matches });
    } catch (e) {
      updateSrc(it.id, b, { status: "failed", matches: [], error: e.message });
    }
  };

  const runItem = async (it) => {
    await Promise.all(active.map((b) => runBackend(it, b)));
  };

  const analyze = async () => {
    if (!imgDataUrl || working) return;
    setError(null);
    setItems([]);
    setPhase("detecting");

    let detected;
    try {
      const data = await callOpenAI({
        model: MODEL,
        max_output_tokens: 1000,
        input: [
          {
            role: "user",
            content: [
              { type: "input_image", image_url: imgDataUrl },
              { type: "input_text", text: DETECT_PROMPT },
            ],
          },
        ],
      });
      const parsed = extractJSON(textOf(data));
      detected = (parsed.items || []).slice(0, 6).map((raw, i) => ({
        id: `it-${Date.now()}-${i}`,
        type: raw.type || "item",
        color: raw.color || "",
        brand: raw.brand || null,
        description: raw.description || "",
        search_query: raw.search_query || `${raw.color || ""} ${raw.type || ""}`.trim(),
        bbox: validBbox(raw.bbox),
        thumb: null,
        src: emptySrc(),
      }));
    } catch (e) {
      setPhase("ready");
      setError(`Detection failed: ${e.message}. Run analysis again.`);
      return;
    }

    if (!detected.length) {
      setPhase("ready");
      setError("No garments detected. Try a clearer, front-facing photo.");
      return;
    }

    const withThumbs = await Promise.all(
      detected.map(async (it) => ({ ...it, thumb: await cropFromDataUrl(imgDataUrl, it.bbox) }))
    );
    setItems(withThumbs);
    setPhase("searching");

    for (const it of withThumbs) {
      await runItem(it);
    }
    setPhase("done");
  };

  const reset = () => {
    setImgDataUrl(null);
    setItems([]);
    setError(null);
    setPhase("idle");
    if (fileRef.current) fileRef.current.value = "";
  };

  const scrollToItem = (id) => {
    const el = document.getElementById(`item-${id}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const statusLine = () => {
    if (phase === "detecting") return "STATUS — DETECTING GARMENTS…";
    if (phase === "searching")
      return `STATUS — SOURCING ${pad2(Math.min(finished + 1, items.length))}/${pad2(items.length)}…`;
    if (phase === "done") return `STATUS — DONE · ${items.length} PIECES · ${totalLinks} LINKS`;
    return "STATUS — READY";
  };

  const engineLabel =
    backend === "web" ? "VLM + WEB SEARCH" : backend === "c3" ? "VLM + CHANNEL3" : "VLM + A/B TEST";

  // groups to render per item: backends that are active now, plus any that already ran
  const groupsFor = (it) =>
    ["web", "c3"].filter((b) => active.includes(b) || it.src[b].status !== "idle");

  return (
    <div className="ll-sans min-h-screen antialiased" style={{ background: C.bg, color: C.ink }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap');
        .ll-sans{font-family:'Archivo',system-ui,-apple-system,sans-serif}
        .ll-mono{font-family:'Space Mono',ui-monospace,SFMono-Regular,monospace;letter-spacing:.02em}
        @keyframes ll-rot{to{transform:rotate(360deg)}}
        .ll-spin{animation:ll-rot .7s linear infinite}
        @keyframes ll-scan{0%{top:0}100%{top:calc(100% - 2px)}}
        .ll-scanline{position:absolute;left:0;right:0;height:2px;background:${C.accent};box-shadow:0 0 14px rgba(43,60,219,.6);animation:ll-scan 1.5s ease-in-out infinite alternate}
        @keyframes ll-up{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
        .ll-fadeup{animation:ll-up .35s ease both}
        .ll-barcode{background:repeating-linear-gradient(90deg,${C.ink} 0 1px,transparent 1px 3px,${C.ink} 3px 5px,transparent 5px 6px,${C.ink} 6px 7px,transparent 7px 10px)}
        button:focus-visible,a:focus-visible,input:focus-visible{outline:2px solid ${C.accent};outline-offset:2px}
        @media (prefers-reduced-motion: reduce){.ll-scanline,.ll-fadeup,.ll-spin{animation:none}}
      `}</style>

      <div className="max-w-5xl mx-auto px-4 py-6 md:px-6 md:py-10">
        {/* ---- title block ---- */}
        <header className="grid grid-cols-1 sm:grid-cols-3 border" style={{ borderColor: C.ink }}>
          <div className="sm:col-span-2 p-4 md:p-5">
            <h1 className="font-bold leading-none tracking-tight text-4xl md:text-5xl">
              LOOK<span style={{ color: C.accent }}>LENS</span>
            </h1>
            <p className="ll-mono text-xs mt-2" style={{ color: C.muted }}>
              SHOP-THE-LOOK · VISUAL SEARCH
            </p>
          </div>
          <div
            className="p-4 md:p-5 border-t sm:border-t-0 sm:border-l ll-mono text-xs"
            style={{ borderColor: C.ink }}
          >
            {[
              ["DOC", "LOOK SHEET"],
              ["REV", "0.2 / PROTOTYPE"],
              ["ENGINE", engineLabel],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 py-0.5">
                <span style={{ color: C.muted }}>{k}</span>
                <span className="text-right">{v}</span>
              </div>
            ))}
          </div>
        </header>

        {/* ---- backend config strip ---- */}
        <div className="mt-4 border" style={{ borderColor: C.line, background: C.surface }}>
          <div className="px-4 py-3 flex flex-wrap items-center gap-2">
            <span className="ll-mono text-xs mr-1" style={{ color: C.muted }}>
              SOURCING BACKEND
            </span>
            {[
              ["web", "WEB SEARCH"],
              ["c3", "CHANNEL3"],
              ["ab", "A/B BOTH"],
            ].map(([v, l]) => (
              <button
                key={v}
                disabled={working}
                onClick={() => setBackend(v)}
                className="ll-mono px-2.5 py-1.5 disabled:opacity-40"
                style={{
                  fontSize: 10,
                  border: `1px solid ${backend === v ? C.ink : C.line}`,
                  background: backend === v ? C.ink : "transparent",
                  color: backend === v ? C.bg : C.ink,
                }}
              >
                {l}
              </button>
            ))}
          </div>
          {needsC3 && (
            <div
              className="px-4 py-3 border-t flex flex-wrap items-center gap-3"
              style={{ borderColor: C.line }}
            >
              <span className="ll-mono text-xs shrink-0" style={{ color: C.muted }}>
                PROXY URL
              </span>
              <input
                value={proxyUrl}
                onChange={(e) => setProxyUrl(e.target.value)}
                placeholder="empty = this app's /api/channel3 · or a deployed origin"
                spellCheck={false}
                autoComplete="off"
                className="ll-mono text-xs px-2 py-1.5 flex-1"
                style={{
                  border: `1px solid ${C.line}`,
                  background: C.bg,
                  minWidth: 220,
                  outline: "none",
                }}
              />
              <span className="ll-mono shrink-0" style={{ fontSize: 10, color: C.muted }}>
                BACKEND HANDLES API KEY
              </span>
            </div>
          )}
        </div>

        {/* ---- error ---- */}
        {error && (
          <div
            className="ll-mono text-xs mt-4 px-3 py-2.5 border ll-fadeup"
            style={{ borderColor: C.danger, color: C.danger, background: "#FDF1EF" }}
          >
            {error}
          </div>
        )}

        {/* ---- upload state ---- */}
        {!imgDataUrl && (
          <div className="mt-6 md:mt-8 ll-fadeup">
            <CropFrame>
              <div
                role="button"
                tabIndex={0}
                aria-label="Upload an outfit photo"
                className="border cursor-pointer text-center px-6 py-16 md:py-24 transition-colors"
                style={{
                  borderColor: dragOver ? C.accent : C.line,
                  background: dragOver ? "#EEF0FD" : C.surface,
                }}
                onClick={() => fileRef.current && fileRef.current.click()}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") fileRef.current && fileRef.current.click();
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  handleFiles(e.dataTransfer.files);
                }}
              >
                <HangerIcon className="mx-auto w-10 h-10" style={{ color: C.accent }} />
                <p className="font-semibold text-xl md:text-2xl mt-4 tracking-tight">
                  Drop a look photo
                </p>
                <p className="ll-mono text-xs mt-2" style={{ color: C.muted }}>
                  OR TAP TO BROWSE · JPG / PNG · FRONT-FACING SHOTS WORK BEST
                </p>
                <p className="ll-mono text-xs mt-8" style={{ color: C.muted }}>
                  01 UPLOAD <span style={{ color: C.accent }}>→</span> 02 DETECT{" "}
                  <span style={{ color: C.accent }}>→</span> 03 SOURCE
                </p>
              </div>
            </CropFrame>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
            />
          </div>
        )}

        {/* ---- workspace ---- */}
        {imgDataUrl && (
          <div className="mt-6 md:mt-8 grid grid-cols-1 md:grid-cols-12 gap-6 md:gap-8 items-start">
            {/* photo / look sheet */}
            <div className="md:col-span-5 md:sticky md:top-6">
              <CropFrame>
                <div
                  className="relative border overflow-hidden"
                  style={{ borderColor: C.line, background: C.surface }}
                >
                  <img src={imgDataUrl} alt="Uploaded outfit" className="w-full block" />
                  {(phase === "searching" || phase === "done") &&
                    items.map(
                      (it, i) =>
                        it.bbox && (
                          <button
                            key={it.id}
                            onClick={() => scrollToItem(it.id)}
                            aria-label={`Jump to item ${i + 1}: ${it.type}`}
                            className="absolute"
                            style={{
                              left: `${it.bbox.x}%`,
                              top: `${it.bbox.y}%`,
                              width: `${it.bbox.w}%`,
                              height: `${it.bbox.h}%`,
                              border: `1.5px solid ${C.accent}`,
                              background: "transparent",
                              padding: 0,
                            }}
                          >
                            <span
                              className="ll-mono absolute flex items-center justify-center"
                              style={{
                                top: -1,
                                left: -1,
                                background: C.accent,
                                color: "#fff",
                                fontSize: 10,
                                padding: "1px 5px",
                              }}
                            >
                              {pad2(i + 1)}
                            </span>
                          </button>
                        )
                    )}
                  {phase === "detecting" && <div className="ll-scanline" aria-hidden="true" />}
                </div>
              </CropFrame>

              <p
                className="ll-mono text-xs mt-2 px-2"
                style={{ color: working ? C.accent : C.muted }}
              >
                {statusLine()}
              </p>

              <div className="mt-4 px-2 flex flex-wrap gap-3">
                {(phase === "ready" || phase === "done") && (
                  <button
                    onClick={analyze}
                    className="ll-mono text-xs px-5 py-3 font-bold tracking-wide"
                    style={{ background: C.ink, color: C.bg }}
                  >
                    {phase === "done" ? "RUN AGAIN" : "ANALYZE LOOK"}
                  </button>
                )}
                {working && (
                  <span
                    className="ll-mono text-xs px-5 py-3 font-bold tracking-wide flex items-center gap-2"
                    style={{ background: C.ink, color: C.bg, opacity: 0.7 }}
                  >
                    <Spinner color={C.bg} /> WORKING…
                  </span>
                )}
                <button
                  onClick={reset}
                  disabled={working}
                  className="ll-mono text-xs px-5 py-3 tracking-wide disabled:opacity-40"
                  style={{ border: `1px solid ${C.ink}`, background: "transparent", color: C.ink }}
                >
                  NEW PHOTO
                </button>
              </div>
            </div>

            {/* item tickets */}
            <div className="md:col-span-7">
              <div
                className="flex items-baseline justify-between border-b pb-2"
                style={{ borderColor: C.ink }}
              >
                <h2 className="font-semibold uppercase tracking-tight text-lg">Detected pieces</h2>
                <span className="ll-mono text-xs" style={{ color: C.muted }}>
                  {items.length > 0
                    ? `${pad2(items.length)} ITEMS${phase === "done" ? ` · ${pad2(totalLinks)} LINKS` : ""}`
                    : "—"}
                </span>
              </div>

              {/* pre-analysis hint */}
              {phase === "ready" && (
                <div
                  className="mt-4 p-5 border ll-fadeup"
                  style={{ borderColor: C.line, background: C.surface }}
                >
                  <p className="ll-mono text-xs" style={{ color: C.accent }}>
                    READY
                  </p>
                  <p className="text-sm mt-2" style={{ color: C.muted }}>
                    Run analysis to detect each garment, crop it out, and source buy links via the
                    selected backend — pick A/B BOTH above to compare web search against the
                    Channel3 catalog side by side.
                  </p>
                </div>
              )}

              {/* detection skeletons */}
              {phase === "detecting" && (
                <div className="mt-4 space-y-4">
                  {[0, 1, 2].map((i) => (
                    <div
                      key={i}
                      className="p-4 border animate-pulse"
                      style={{ borderColor: C.line, background: C.surface }}
                    >
                      <div className="h-3 w-24" style={{ background: C.line }} />
                      <div className="flex gap-4 mt-4">
                        <div className="w-16 h-16" style={{ background: C.line }} />
                        <div className="flex-1">
                          <div className="h-3 w-full" style={{ background: C.line }} />
                          <div className="h-3 w-2/3 mt-2" style={{ background: C.line }} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* tickets */}
              <div className="mt-4 space-y-4">
                {items.map((it, idx) => {
                  const groups = groupsFor(it);
                  const allIdle = groups.every((b) => it.src[b].status === "idle");
                  const allSettled = groups.every(
                    (b) => it.src[b].status === "done" || it.src[b].status === "failed"
                  );
                  const itemLinks = groups.reduce((n, b) => n + it.src[b].matches.length, 0);
                  return (
                    <article
                      key={it.id}
                      id={`item-${it.id}`}
                      className="border ll-fadeup"
                      style={{ borderColor: C.line, background: C.surface }}
                    >
                      {/* ticket header */}
                      <div
                        className="flex items-center justify-between gap-3 px-4 py-2 border-b"
                        style={{ borderColor: C.line }}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="ll-mono text-xs font-bold" style={{ color: C.accent }}>
                            {pad2(idx + 1)}
                          </span>
                          <span className="font-semibold uppercase tracking-wide text-sm truncate">
                            {it.type}
                          </span>
                          {it.brand && (
                            <span
                              className="ll-mono px-1.5 py-0.5 shrink-0"
                              style={{ border: `1px solid ${C.ink}`, fontSize: 10 }}
                            >
                              {it.brand}
                            </span>
                          )}
                        </div>
                        <div className="ll-barcode w-8 h-3 shrink-0" aria-hidden="true" />
                      </div>

                      {/* ticket body */}
                      <div className="p-4 flex gap-4">
                        {it.thumb ? (
                          <img
                            src={it.thumb}
                            alt={`Cropped ${it.type}`}
                            className="w-16 h-16 md:w-20 md:h-20 object-cover border shrink-0"
                            style={{ borderColor: C.line }}
                          />
                        ) : (
                          <div
                            className="w-16 h-16 md:w-20 md:h-20 border shrink-0 flex items-center justify-center"
                            style={{ borderColor: C.line, color: C.line }}
                          >
                            <HangerIcon className="w-6 h-6" />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="ll-mono text-xs uppercase" style={{ color: C.muted }}>
                            COLOR · {it.color || "—"}
                          </p>
                          <p className="text-sm mt-1.5 leading-relaxed">{it.description}</p>
                        </div>
                      </div>

                      {/* sourcing */}
                      <div className="px-4 pb-4">
                        <div className="border-t pt-3 space-y-3" style={{ borderColor: C.line }}>
                          {allIdle && (
                            <p className="ll-mono text-xs" style={{ color: C.muted }}>
                              QUEUED
                            </p>
                          )}
                          {!allIdle &&
                            groups.map((b) => {
                              const g = it.src[b];
                              if (g.status === "idle") return null;
                              return (
                                <div key={b}>
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span
                                      className="ll-mono font-bold"
                                      style={{ fontSize: 10, color: C.ink }}
                                    >
                                      VIA {BACKENDS[b].label}
                                    </span>
                                    {g.status === "searching" && <Spinner />}
                                    {g.status === "done" && (
                                      <span className="ll-mono" style={{ fontSize: 10, color: C.muted }}>
                                        — {pad2(g.matches.length)} LINK{g.matches.length === 1 ? "" : "S"}
                                      </span>
                                    )}
                                    {g.status === "failed" && (
                                      <>
                                        <span
                                          className="ll-mono"
                                          style={{ fontSize: 10, color: C.danger }}
                                        >
                                          — FAILED
                                        </span>
                                        <button
                                          onClick={() => runBackend(it, b)}
                                          className="ll-mono underline"
                                          style={{ fontSize: 10, color: C.ink }}
                                        >
                                          RETRY
                                        </button>
                                      </>
                                    )}
                                  </div>
                                  {g.status === "failed" && g.error && (
                                    <p
                                      className="ll-mono mt-1"
                                      style={{ fontSize: 10, color: C.danger }}
                                    >
                                      {g.error}
                                    </p>
                                  )}
                                  {g.status === "done" && g.matches.length === 0 && (
                                    <p className="ll-mono mt-1" style={{ fontSize: 10, color: C.muted }}>
                                      NO CONFIDENT MATCH
                                    </p>
                                  )}
                                  {g.matches.map((m, j) => (
                                    <a
                                      key={j}
                                      href={m.url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="flex items-center justify-between gap-3 py-2.5 group"
                                      style={{
                                        borderTop: j > 0 ? `1px solid ${C.line}` : "none",
                                      }}
                                    >
                                      <div className="flex items-center gap-3 min-w-0">
                                        {m.image && (
                                          <img
                                            src={m.image}
                                            alt=""
                                            className="w-10 h-10 object-cover border shrink-0"
                                            style={{ borderColor: C.line }}
                                            onError={(e) => {
                                              e.currentTarget.style.display = "none";
                                            }}
                                          />
                                        )}
                                        <div className="min-w-0">
                                          <p className="text-sm font-medium truncate group-hover:underline">
                                            {m.product_name || "Product listing"}
                                          </p>
                                          <p
                                            className="ll-mono text-xs mt-0.5 truncate"
                                            style={{ color: C.muted }}
                                          >
                                            {[m.retailer, m.price, m.note]
                                              .filter(Boolean)
                                              .join(" · ")}
                                          </p>
                                        </div>
                                      </div>
                                      <div className="flex items-center gap-2 shrink-0">
                                        <Badge
                                          type={m.match_type === "exact" ? "exact" : "similar"}
                                        />
                                        <ArrowIcon className="w-4 h-4" style={{ color: C.ink }} />
                                      </div>
                                    </a>
                                  ))}
                                </div>
                              );
                            })}
                          {allSettled && itemLinks === 0 && (
                            <p className="ll-mono" style={{ fontSize: 10, color: C.muted }}>
                              MANUAL QUERY: <span style={{ color: C.ink }}>{it.search_query}</span>
                            </p>
                          )}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ---- footer ---- */}
        <footer className="mt-10 border-t pt-3 pb-6" style={{ borderColor: C.line }}>
          <p className="ll-mono text-xs leading-relaxed" style={{ color: C.muted }}>
            PROTOTYPE NOTES — DETECTION VIA VISION-LANGUAGE MODEL; BOUNDING BOXES ARE APPROXIMATE.
            CHANNEL3 MODE REQUIRES A BACKEND PROXY (node channel3-proxy.js) WITH CHANNEL3_API_KEY ENV VAR.
            SOURCING: LIVE WEB SEARCH AND/OR CHANNEL3 CATALOG (US-FIRST COVERAGE). "EXACT" BADGE =
            DETECTED-BRAND MATCH HEURISTIC. VERIFY LINKS BEFORE PURCHASE.
          </p>
        </footer>
      </div>
    </div>
  );
}
