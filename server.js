const http = require("http");
const fs = require("fs/promises");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const SOURCE_URL = "https://satta-king-fast.com/";
const SOURCE_ORIGIN = new URL(SOURCE_URL).origin;
const READER_URL = "https://r.jina.ai/http://r.jina.ai/http://";

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
};

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

function stripMarkdown(value = "") {
  return decodeHtml(value)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/[#*_`>]/g, " ")
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

function extractMetaContent(cleanHtml, names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));

  for (const match of cleanHtml.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const name = (getAttr(tag, "name") || getAttr(tag, "property")).toLowerCase();

    if (wanted.has(name)) {
      return getAttr(tag, "content");
    }
  }

  return "";
}

function extractLooseResultTable(cleanHtml, pageUrl) {
  const rows = [...cleanHtml.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)]
    .map((rowMatch) => {
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
        className: getAttr(rowMatch[1], "class"),
        id: getAttr(rowMatch[1], "id"),
        cells,
      };
    })
    .filter((row) => row.cells.length)
    .slice(0, 180);

  const hasResultRows = rows.some((row) => /game-result|board-title|board-head|board-section/i.test(row.className));
  if (!hasResultRows) return [];

  const title =
    rows.find((row) => /board-title/i.test(row.className))?.cells[0]?.text ||
    "Satta King Fast Results";

  return [
    {
      title,
      className: "quick-result-board",
      rows,
      rowCount: rows.length,
    },
  ];
}

function extractMarkdownLinks(value = "") {
  return [...value.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)]
    .map((match) => ({
      text: stripMarkdown(match[1]),
      href: absolutize(SOURCE_URL, match[2]),
    }))
    .filter((link) => link.href);
}

function extractMarkdownData(markdown, pageUrl, responseMeta) {
  const title = stripMarkdown(markdown.match(/^Title:\s*(.+)$/m)?.[1] || "");
  const content = markdown.split("Markdown Content:")[1] || markdown;
  const description =
    stripMarkdown(content.match(/\*\*DISCLAIMER:\*\*\s*([\s\S]*?)(?:\n\n|Updated:)/i)?.[1] || "") ||
    title;
  const updated = stripMarkdown(content.match(/Updated:\s*.+?IST\./i)?.[0] || "");
  const rows = [];

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || /^(\|\s*-+\s*)+\|?$/.test(trimmed)) continue;

    const parts = trimmed
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((part) => part.trim())
      .filter(Boolean);

    if (!parts.length) continue;

    const firstText = stripMarkdown(parts[0]);
    let className = "";

    if (/Satta King Fast Results/i.test(firstText)) className = "board-title";
    else if (/Regional Offline Draw Results/i.test(firstText)) className = "board-head";
    else if (/^(LIVE|NEXT|REST)$/i.test(firstText)) className = "board-section";
    else if (/Record Chart/i.test(firstText)) className = "game-result";

    const cells = parts.map((part, index) => ({
      tag: className === "board-title" || className === "board-head" ? "th" : "td",
      text: stripMarkdown(part),
      className: index === 0 ? "game-details" : index === 1 ? "yesterday-number" : "today-number",
      colspan: parts.length === 1 ? 3 : 1,
      links: extractMarkdownLinks(part),
    }));

    rows.push({ className, id: "", cells });
  }

  const tableRows = rows.filter((row) => row.className || row.cells.length >= 3);
  const text = stripMarkdown(content).slice(0, 6000);

  return {
    url: pageUrl,
    status: responseMeta.status,
    contentType: responseMeta.contentType,
    title,
    description,
    headings: rows.map((row) => row.cells[0]?.text).filter(Boolean).slice(0, 20),
    links: uniqueBy(
      [...content.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)].map((match) => ({
        text: stripMarkdown(match[1]),
        href: absolutize(pageUrl, match[2]),
      })),
      (link) => link.href
    ).slice(0, 25),
    images: [],
    sections: description
      ? [
          {
            tag: "div",
            id: "",
            className: "disclaimer",
            label: "disclaimer",
            text: description,
          },
        ]
      : [],
    tables: tableRows.length
      ? [
          {
            title: tableRows.find((row) => /board-title/i.test(row.className))?.cells[0]?.text || title,
            className: "quick-result-board",
            rows: tableRows.slice(0, 180),
            rowCount: tableRows.length,
          },
        ]
      : [],
    text: updated ? `${updated} ${text}` : text,
    wordCount: text ? text.split(/\s+/).length : 0,
  };
}

function hasUsableResults(data) {
  return Boolean(
    data?.description &&
      data?.tables?.some((table) => {
        const label = `${table.title || ""} ${table.className || ""}`;
        const hasResultLabel = /result|quick-result/i.test(label);
        const hasGameRows = table.rows?.some((row) =>
          row.cells?.some((cell) => /Record Chart/i.test(cell.text || ""))
        );

        return table.rows?.length && (hasResultLabel || hasGameRows);
      })
  );
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchDirectData(target) {
  const response = await fetchWithTimeout(target.href, {
    headers: FETCH_HEADERS,
    redirect: "follow",
  });

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
    throw new Error(`This URL returned ${contentType || "an unsupported content type"}.`);
  }

  const html = await response.text();
  return extractWebsiteData(html, response.url, {
    status: response.status,
    contentType,
  });
}

async function fetchReaderData(target) {
  const readerTarget = `${READER_URL}${target.href}`;
  const response = await fetchWithTimeout(readerTarget, {
    headers: FETCH_HEADERS,
    redirect: "follow",
  });
  const contentType = response.headers.get("content-type") || "";
  const markdown = await response.text();

  if (!response.ok) {
    throw new Error(`Reader fallback failed with status ${response.status}.`);
  }

  return extractMarkdownData(markdown, target.href, {
    status: response.status,
    contentType,
  });
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
  const description = extractMetaContent(cleanHtml, ["description", "og:description"]);

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
  const resultTables = tables.length ? tables : extractLooseResultTable(cleanHtml, pageUrl);
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
    tables: resultTables,
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
  let target;

  try {
    const body = await readRequestBody(req);
    const { url } = JSON.parse(body || "{}");
    target = new URL(url || SOURCE_URL, SOURCE_URL);

    if (!["http:", "https:"].includes(target.protocol)) {
      return sendJson(res, 400, { error: "Only http and https URLs are supported." });
    }

    if (target.origin !== SOURCE_ORIGIN) {
      return sendJson(res, 400, { error: `Only ${SOURCE_ORIGIN} pages can be loaded.` });
    }

    let data = await fetchDirectData(target);

    if (!hasUsableResults(data)) {
      data = await fetchReaderData(target);
    }

    sendJson(res, 200, data);
  } catch (error) {
    try {
      const data = await fetchReaderData(target || new URL(SOURCE_URL));
      sendJson(res, 200, data);
    } catch {
      sendJson(res, 400, { error: error.message || "Could not read the website." });
    }
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
