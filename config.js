/*
 * RDR report configuration.
 *
 * The Excel columns are still being finalised, so the parser maps headers
 * loosely (case/space-insensitive, with aliases). Add aliases here when the
 * sheet's wording changes — no other code needs to touch.
 */
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

// Secret for signing session cookies. From env in production; otherwise
// generated once and persisted so logins survive restarts.
function resolveSecret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  const f = path.join(DATA_DIR, "secret.key");
  try { return fs.readFileSync(f, "utf8"); }
  catch (_) { const s = crypto.randomBytes(32).toString("hex"); fs.writeFileSync(f, s); return s; }
}

module.exports = {
  PORT: Number(process.env.PORT) || 5055,
  DATA_DIR,
  LATEST_JSON: path.join(DATA_DIR, "latest.json"),      // legacy single dataset
  DATASETS_DIR: path.join(DATA_DIR, "datasets"),         // one JSON per partner
  USERS_JSON: path.join(DATA_DIR, "users.json"),
  PARTNERS_JSON: path.join(DATA_DIR, "partners.json"),
  AUTH_SECRET: resolveSecret(),
  SESSION_TTL_MS: 1000 * 60 * 60 * 24 * 14,              // 14 days
  CURRENCY: "₱",

  // Which sheets to treat as the master register. Per-client breakdown tabs
  // repeat the same rows, so we only ingest the master sheet(s) to avoid
  // double-counting. If no sheet name matches, the first data sheet is used.
  MASTER_SHEET_RE: /SALES REPORT|SUMMARY|REGISTER|MASTER/i,

  // Canonical field -> list of accepted header spellings (normalised: upper,
  // trimmed, single spaces). First match wins.
  COLUMN_ALIASES: {
    date:        ["INVOICE DATE (DD/MM/YYYY)", "INVOICE DATE", "DATE OF INVOICE", "DATE"],
    invoice:     ["RESERVE NO.", "RESERVE NO", "RESERVE NUMBER", "INVOICE #", "INVOICE NO", "INVOICE NUMBER", "INVOICE"],
    client:      ["CLIENT NAME", "CLIENT", "CUSTOMER", "CUSTOMER NAME"],
    pjCode:      ["PJ CODE", "PJ", "PJCODE"],
    itemCode:    ["ITEM CODE", "ITEMCODE", "SKU"],
    itemType:    ["ITEM TYPE", "TYPE", "CATEGORY"],
    supplier:    ["SUPPLIER NAME", "SUPPLIER"],
    weight:      ["WEIGHT", "WEIGHT (G)", "GRAMS", "WT"],
    capitalPerGram: ["PRICE PER GRAM", "PRICE PER GRAM CAPITAL", "CAPITAL PER GRAM"],
    // Cost basis — called "CAPITAL PRICE" on the July sheet, "SUPPLIER PRICE" on August.
    supplierPrice: ["CAPITAL PRICE", "SUPPLIER PRICE", "CAPITAL", "COST"],
    markup:      ["MARKUP"],
    amount:      ["SELLING PRICE", "ITEM AMOUNT", "AMOUNT", "TOTAL AMOUNT", "ITEM TOTAL", "SALES"],
    profit:      ["PROFIT"],
    onelive:     ["ONELIVE PROFIT", "ONELIVE PROFIT AMOUNT", "PJ PROFIT"],
    commissionType: ["COMMISSION TYPE"],
    // Rate column (₱/gram for gold, % for jewelry).
    commission:  ["RDR COMMISSION", "COMMISSION", "COMMISSION %", "COMMISSION RATE"],
    // The peso value of the commission (this is what the KPIs sum).
    commissionValue: ["RDR COMMISSION AMOUNT", "RDR COMMISSION TOTAL VALUE",
                      "COMMISSION TOTAL VALUE", "RDR COMMISSION TOTAL", "COMMISSION VALUE", "COMMISSION AMOUNT"],
  },
};
