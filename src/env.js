/*
 * Minimal .env loader — no dependency.
 *
 * Reads a .env file at the project root into process.env so local development
 * doesn't need the connection string retyped in every new terminal. On Render
 * there is no .env file and the real environment is used, so this is a no-op
 * in production.
 *
 * Deliberately NOT the `dotenv` package: this is ~30 lines, and one fewer
 * dependency on a project that handles money is worth more than the polish.
 *
 * Rules:
 *   - a real environment variable always wins over the file, so
 *     `$env:DATABASE_URL=... ; npm start` still overrides .env for one run
 *   - `#` starts a comment, blank lines are skipped
 *   - surrounding quotes are stripped: KEY="value" and KEY=value are the same
 *   - `export KEY=value` is accepted, for people pasting from a shell
 *
 * .env is gitignored and must stay that way — it holds the database password.
 */
const fs = require("fs");
const path = require("path");

function loadEnv(file = path.join(__dirname, "..", ".env")) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (_) {
    return { loaded: false, keys: [] };   // no .env is completely normal
  }

  const keys = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;

    const key = m[1];
    let value = m[2].trim();

    // Strip one matching pair of surrounding quotes. Anything inside them —
    // including the # of a URL-encoded password — is kept verbatim.
    const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, "").trim();   // trailing comment

    // A variable set in the real environment wins.
    if (process.env[key] === undefined) {
      process.env[key] = value;
      keys.push(key);
    }
  }
  return { loaded: true, keys };
}

module.exports = { loadEnv };
