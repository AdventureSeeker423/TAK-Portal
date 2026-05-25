const sanitizeHtml = require("sanitize-html");

const BASE_ALLOWED_TAGS = [
  "p",
  "br",
  "div",
  "span",
  "h1",
  "h2",
  "h3",
  "h4",
  "strong",
  "em",
  "u",
  "ul",
  "ol",
  "li",
  "a",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "blockquote",
  "hr",
];

const BASE_ALLOWED_ATTRIBUTES = {
  a: ["href", "title", "target", "rel"],
  div: ["dir"],
  span: ["dir"],
  p: ["dir"],
  table: ["border", "cellpadding", "cellspacing"],
  th: ["colspan", "rowspan"],
  td: ["colspan", "rowspan"],
};

function sanitizeMouHtml(html) {
  return sanitizeHtml(String(html || ""), {
    allowedTags: BASE_ALLOWED_TAGS,
    allowedAttributes: BASE_ALLOWED_ATTRIBUTES,
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesAppliedToAttributes: ["href"],
    disallowedTagsMode: "discard",
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", {
        rel: "noopener noreferrer",
        target: "_blank",
      }),
    },
  });
}

function sanitizeUserAgreementHtml(html) {
  return sanitizeHtml(String(html || ""), {
    allowedTags: ["p", "br", "strong", "em", "u", "a"],
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesAppliedToAttributes: ["href"],
    disallowedTagsMode: "discard",
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", {
        rel: "noopener noreferrer",
        target: "_blank",
      }),
    },
  });
}

module.exports = {
  sanitizeMouHtml,
  sanitizeUserAgreementHtml,
};
