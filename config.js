/*
 * Perfect Jewel accounting — configuration.
 *
 * Storage is PostgreSQL now (set DATABASE_URL); the old data/ file paths are
 * gone. What's left here is the port, the currency, and the Excel column map.
 *
 * The Excel columns are still being finalised, so the parser maps headers
 * loosely (case/space-insensitive, with aliases). Add aliases here when the
 * sheet's wording changes — no other code needs to touch.
 */

module.exports = {
  PORT: Number(process.env.PORT) || 5055,
  // Maintenance mode cuts off app access and shows the maintenance page.
  MAINTENANCE_MODE: String(process.env.MAINTENANCE_MODE || "false").toLowerCase() === "true" ||
    String(process.env.MAINTENANCE_MODE || "false").toLowerCase() === "1" ||
    String(process.env.MAINTENANCE_MODE || "false").toLowerCase() === "yes",
  MAINTENANCE_MESSAGE: process.env.MAINTENANCE_MESSAGE || "The system is temporarily under maintenance.",
  // How long a login lasts. The signing secret lives in the settings table
  // (or the AUTH_SECRET env var) — see src/auth.js.
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
    // Whether the client has paid for the item yet (PAID / UNPAID).
    sellerStatus: ["SELLER STATUS", "SELLER PAYMENT STATUS", "PAYMENT STATUS"],
  },
};
