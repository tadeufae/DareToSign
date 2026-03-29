const BLOCK_TAGS = [
  "address",
  "article",
  "blockquote",
  "br",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "main",
  "ol",
  "p",
  "section",
  "table",
  "tr",
  "ul"
];

export function extractText(html) {
  let text = "";

  if (typeof DOMParser !== "undefined") {
    text = extractWithDomParser(html);
  }

  if (!text) {
    text = extractWithRegex(html);
  }

  if (text.length < 200) {
    throw new Error("Could not extract meaningful text from this page.");
  }

  return text;
}

function extractWithDomParser(html) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    doc.querySelectorAll("script, style, nav, header, footer, aside, form, button, img, svg").forEach((node) => {
      node.remove();
    });

    const blocks = Array.from(doc.body.querySelectorAll(BLOCK_TAGS.join(",")));
    if (blocks.length === 0) {
      return normalize(doc.body.textContent || "");
    }

    return normalize(
      blocks
        .map((node) => node.textContent || "")
        .filter(Boolean)
        .join("\n\n")
    );
  } catch {
    return "";
  }
}

function extractWithRegex(html) {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|header|footer|aside|form|button|img|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/section|\/article|\/li|\/tr|\/table|\/ul|\/ol|\/h[1-6])>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ");

  return normalize(stripped);
}

function normalize(text) {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
