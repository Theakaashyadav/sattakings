const http = require("http");
const fs = require("fs/promises");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const SOURCE_URL = "https://satta-king-fast.com/";
const SOURCE_ORIGIN = new URL(SOURCE_URL).origin;

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text, contentType = "text/plain") {
  res.writeHead(statusCode, { "Content-Type": contentType });
  res.end(text);
}

function decodeHtml(value = "") {
  const entities = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };

  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (_, entity) => entities[entity.toLowerCase()] || `&${entity};`);
}

function stripTags(html = "") {
  return decodeHtml(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function getAttr(tag, name) {
  const pattern = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = tag.match(pattern);
  return decodeHtml(match?.[2] || match?.[3] || match?.[4] || "");
}

function absolutize(baseUrl, maybeUrl) {
  try {
    return new URL(maybeUrl, baseUrl).href;
  } catch {
    return "";
  }
}

function uniqueBy(items, key) {
  const seen = new Set();
  return items.filter((item) => {
    const value = key(item);
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function extractTables(cleanHtml, pageUrl) {
  return [...cleanHtml.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi)]
    .map((match, index) => {
      const tableTag = match[0].match(/<table\b[^>]*>/i)?.[0] || "";
      const tableHtml = match[2];
      const title =
        stripTags(tableHtml.match(/<caption\b[^>]*>([\s\S]*?)<\/caption>/i)?.[1] || "") ||
        stripTags(tableHtml.match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i)?.[1] || "") ||
        `Table ${index + 1}`;

      const rows = [...tableHtml.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)]
        .map((rowMatch) => {
          const rowAttrs = rowMatch[1];
          const cells = [...rowMatch[2].matchAll(/<(th|td)\b([^>]*)>([\s\S]*?)<\/(?:th|td)>/gi)]
            .map((cellMatch) => ({
              tag: cellMatch[1].toLowerCase(),
              text: stripTags(cellMatch[3]),
              className: getAttr(cellMatch[2], "class"),
              colspan: Number(getAttr(cellMatch[2], "colspan")) || 1,
              links: [...cellMatch[3].matchAll(/<a\b[^>]*href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)[^>]*>([\s\S]*?)<\/a>/gi)]
                .map((linkMatch) => ({
                  href: absolutize(pageUrl, getAttr(linkMatch[0], "href")),
                  text: stripTags(linkMatch[2]),
                }))
                .filter((link) => link.href),
            }))
            .filter((cell) => cell.text)
            .slice(0, 12);

          return {
            className: getAttr(rowAttrs, "class"),
            id: getAttr(rowAttrs, "id"),
            cells,
          };
        })
        .filter((row) => row.cells.length)
        .slice(0, 140);

      return {
        title,
        className: getAttr(tableTag, "class"),
        rows,
        rowCount: rows.length,
      };
    })
    .filter((table) => table.rows.length)
    .slice(0, 8);
}

function extractSections(cleanHtml) {
  return [...cleanHtml.matchAll(/<(header|nav|main|section|article|aside|footer|div)\b([^>]*)>([\s\S]*?)<\/\1>/gi)]
    .map((match) => {
      const tag = match[1].toLowerCase();
      const attrs = match[2];
      const blockHtml = match[3];
      const id = getAttr(attrs, "id");
      const className = getAttr(attrs, "class");
      const heading = stripTags(blockHtml.match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i)?.[1] || "");
      const label = heading || id || className || tag;
      const text = stripTags(blockHtml).slice(0, 260);

      return {
        tag,
        id,
        className,
        label,
        text,
      };
    })
    .filter((section) => section.text)
    .slice(0, 30);
}

function extractWebsiteData(html, pageUrl, responseMeta) {
  const cleanHtml = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");

  const title = stripTags(cleanHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  const description =
    getAttr(cleanHtml.match(/<meta[^>]+name=["']description["'][^>]*>/i)?.[0] || "", "content") ||
    getAttr(cleanHtml.match(/<meta[^>]+property=["']og:description["'][^>]*>/i)?.[0] || "", "content");

  const headings = [...cleanHtml.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
    .map((match) => stripTags(match[1]))
    .filter(Boolean)
    .slice(0, 20);

  const links = uniqueBy(
    [...cleanHtml.matchAll(/<a\b[^>]*href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)[^>]*>([\s\S]*?)<\/a>/gi)]
      .map((match) => {
        const tag = match[0];
        const href = absolutize(pageUrl, getAttr(tag, "href"));
        return { href, text: stripTags(match[2]) || href };
      })
      .filter((link) => link.href.startsWith("http")),
    (link) => link.href
  ).slice(0, 25);

  const images = uniqueBy(
    [...cleanHtml.matchAll(/<img\b[^>]*>/gi)]
      .map((match) => {
        const tag = match[0];
        const src = absolutize(pageUrl, getAttr(tag, "src") || getAttr(tag, "data-src"));
        return { src, alt: getAttr(tag, "alt") };
      })
      .filter((image) => image.src.startsWith("http")),
    (image) => image.src
  ).slice(0, 20);

  const bodyHtml = cleanHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] || cleanHtml;
  const text = stripTags(bodyHtml).slice(0, 6000);
  const wordCount = text ? text.split(/\s+/).length : 0;
  const tables = extractTables(cleanHtml, pageUrl);
  const sections = extractSections(cleanHtml);

  return {
    url: pageUrl,
    status: responseMeta.status,
    contentType: responseMeta.contentType,
    title,
    description,
    headings,
    links,
    images,
    sections,
    tables,
    text,
    wordCount,
  };
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    if (Buffer.concat(chunks).length > 1024 * 1024) {
      throw new Error("Request body is too large.");
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handleRead(req, res) {
  try {
    const body = await readRequestBody(req);
    const { url } = JSON.parse(body || "{}");
    const target = new URL(url || SOURCE_URL, SOURCE_URL);

    if (!["http:", "https:"].includes(target.protocol)) {
      return sendJson(res, 400, { error: "Only http and https URLs are supported." });
    }

    if (target.origin !== SOURCE_ORIGIN) {
      return sendJson(res, 400, { error: `Only ${SOURCE_ORIGIN} pages can be loaded.` });
    }

    const response = await fetch(target.href, {
      headers: {
        "User-Agent": "Sattakings/1.0",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      return sendJson(res, 415, { error: `This URL returned ${contentType || "an unsupported content type"}.` });
    }

    const html = await response.text();
    const data = extractWebsiteData(html, response.url, {
      status: response.status,
      contentType,
    });

    sendJson(res, 200, data);
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Could not read the website." });
  }
}

async function handleStatic(req, res) {
  const requestedPath = req.url === "/" ? "/index.html" : req.url;
  const filePath = path.normalize(path.join(ROOT, requestedPath));

  if (!filePath.startsWith(ROOT)) {
    return sendText(res, 403, "Forbidden");
  }

  try {
    const file = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const contentType = ext === ".html" ? "text/html" : "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(file);
  } catch {
    sendText(res, 404, "Not found");
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/read") {
    handleRead(req, res);
    return;
  }

  if (req.method === "GET") {
    handleStatic(req, res);
    return;
  }

  sendText(res, 405, "Method not allowed");
});

server.listen(PORT, () => {
  console.log(`Sattakings.com running at http://localhost:${PORT}`);
});
