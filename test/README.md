# Tests

No test framework and no dev dependencies — the two libraries these need are
heavy, and installing them on every Render deploy would be wasteful. Install
them only when you want to run the suites:

```bash
npm i --no-save pg-mem jsdom

node test/preflight.js       # role scoping + data leaks     (pg-mem)
node test/superadmin.js      # account rules + archival      (pg-mem)
node test/upload-guard.js    # upload merge + conflict resolve (pg-mem)
node test/ui-smoke.js        # the page itself               (jsdom)
node test/maintenance-ui.js  # maintenance page logic        (jsdom)
```

Run all before any deploy. Each exits non-zero on failure.

| Suite | The question it answers |
|---|---|
| `preflight.js` | Can a partner see or change anything outside their scope? |
| `superadmin.js` | Can an ordinary admin lock out the superadmin — or each other? |
| `upload-guard.js` | Does an upload add/update instead of replacing — new rows added, unchanged rows left alone, changed rows held for admin approval? |
| `ui-smoke.js` | Does the page render, drill down, and recolour in dark mode? |

`pg-mem` is an in-memory Postgres, so these run without a database and never
touch live data. `jsdom` runs the real `index.html` and `app.js` against a
stubbed API.

## A trap worth knowing about

`ui-smoke.js` inlines `style.css` by hand, because jsdom does not fetch
`<link rel=stylesheet>`. Without that, every `cssVar()` lookup returns `""`,
the code falls back to its hardcoded defaults, and the colour assertions pass
while testing nothing. The suite asserts a guard token first for that reason —
if the stylesheet ever fails to load, the tests fail loudly instead of
silently passing on fallbacks.
