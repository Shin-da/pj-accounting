/*
 * Build an anonymised copy of the real dataset for local development.
 *
 * Every financial figure — amount, weight, capital, commission — stays
 * exact, so totals, margin %, and the payouts reconciliation all still
 * check out. Only identity fields are replaced: client, supplier, invoice
 * number, PJ code, item code. The mapping is deterministic (same real name
 * always becomes the same fake name), so a client who appears on 12 rows in
 * the real file still appears as the same fake client on the same 12 rows —
 * the "repeat client" shape of the data survives, which is what makes it
 * useful for testing the By-client report and the drill-downs.
 *
 *     node scripts/anonymize.js
 *
 * Reads  data/datasets/rdr.json   (the real file — never touched)
 * Writes data/dev/rdr.anon.json   (safe to commit... but isn't; see below)
 *
 * The output still isn't committed. It's derived from real business data
 * (real sales volumes, real commission rates, a real client roster shape),
 * and this repo is public-adjacent enough that "derived from real data" is
 * reason enough to keep it out of git. Regenerate it locally instead —
 * it takes under a second.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SRC = path.join(__dirname, "..", "data", "datasets", "rdr.json");
const OUT_DIR = path.join(__dirname, "..", "data", "dev");
const OUT = path.join(OUT_DIR, "rdr.anon.json");

// Deterministic per-value fake names: same real value -> same fake value,
// every time this script runs, without ever storing the real value anywhere.
const FIRST = ["Aria","Beni","Cora","Dante","Elva","Farid","Gina","Huan","Ivy","Jelo",
  "Kira","Luis","Mira","Nico","Opal","Perla","Quen","Rio","Sena","Tavi"];
const LAST  = ["Delacroix","Estrella","Fuentes","Gonzalo","Hidalgo","Irigo","Javar",
  "Karagdag","Lumban","Mendez","Nazario","Ocampo","Pineda","Quirante","Rosario","Salcedo"];
const SUPPLIER = ["Amberlane Trading","Brightpoint Metals","Copperfield Bullion",
  "Dawnvale Supply","Everstone Traders","Falconridge Gold","Goldenreach Co."];

function pick(list, seed) {
  const n = parseInt(crypto.createHash("md5").update(seed).digest("hex").slice(0, 8), 16);
  return list[n % list.length];
}
function fakeName(real, cache) {
  if (cache.has(real)) return cache.get(real);
  const fake = `${pick(FIRST, real + "f")} ${pick(LAST, real + "l")}`.toUpperCase();
  cache.set(real, fake);
  return fake;
}
function fakeSupplier(real, cache) {
  if (cache.has(real)) return cache.get(real);
  const fake = pick(SUPPLIER, real);
  cache.set(real, fake);
  return fake;
}
function fakeCode(real, cache, prefix) {
  if (real === "-" || real === "" || real == null) return real;   // preserve blanks as-is
  if (cache.has(real)) return cache.get(real);
  const fake = prefix + String(cache.size + 1).padStart(5, "0");
  cache.set(real, fake);
  return fake;
}

function anonymize() {
  const raw = JSON.parse(fs.readFileSync(SRC, "utf8"));
  const clients = new Map(), suppliers = new Map(), pjCodes = new Map(), itemCodes = new Map(), invoices = new Map();

  const records = raw.records.map((r) => ({
    ...r,
    client: fakeName(r.client, clients),
    supplier: /^GOLD$|^JEWELRY$/i.test(String(r.supplier || ""))
      ? r.supplier                              // this column sometimes holds the commission type, not a real supplier — leave those alone
      : fakeSupplier(r.supplier, suppliers),
    invoice: r.invoice ? fakeCode(r.invoice, invoices, "RDR0") : r.invoice,
    pjCode: fakeCode(r.pjCode, pjCodes, "PJ"),
    itemCode: fakeCode(r.itemCode, itemCodes, "IC"),
    // amount, weight, capitalPerGram, supplierPrice, onelive, commission,
    // commissionType, commissionValue, date, itemType, sheet: unchanged —
    // these are what the numbers in every report have to reconcile against.
  }));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ records, meta: { ...raw.meta, anonymized: true } }, null, 2));

  console.log(`Anonymised ${records.length} rows -> ${path.relative(process.cwd(), OUT)}`);
  console.log(`  ${clients.size} clients, ${suppliers.size} suppliers renamed (deterministically)`);
  console.log(`  totals are unchanged — reconciliation still checks out`);
}

if (require.main === module) anonymize();
module.exports = { anonymize };
