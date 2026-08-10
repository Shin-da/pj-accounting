# RDR Sales & Commission Report

A **view-only dashboard** of RDR's sales and commission, fed by an Excel upload — built to hand a link to RDR's CEO, Reymond "RDR" delos Reyes. Headline numbers, charts, and the full sales register, all from the uploaded sheet.

Node.js + Express + SheetJS (parsing) + Chart.js (charts). Pure JavaScript — no build step, no database yet. The last upload is remembered so the link always shows current numbers.

## Run locally

```
cd rdr-report
npm install
npm run start
```

Open **http://localhost:5055**, click **Upload Excel**, choose the RDR sales file. Anyone who opens the URL sees the dashboard (read-only); only the Upload button changes the data.

## The Excel

Columns are matched by name (case- and order-insensitive), so the layout can change without breaking anything. Currently recognised (see `config.js` to add spellings):

`DATE OF INVOICE · INVOICE # · CLIENT NAME · PJ CODE · ITEM CODE · ITEM TYPE · WEIGHT · PRICE PER GRAM CAPITAL · ITEM AMOUNT · RDR COMMISSION · RDR COMMISSION TOTAL VALUE`

Missing columns are reported after upload; the dashboard still works with whatever it found.

## Deploy (Render)

1. Push this folder to a Git repo.
2. On Render: **New → Web Service**, point it at the repo.
3. Build command `npm install`, start command `npm run start`. Render sets `PORT` automatically.
4. (Optional) set an env var `UPLOAD_KEY` to a secret — then uploading requires that key, while viewing stays open. Handy so only you can refresh the data.

Railway works the same way. On these hosts the uploaded file lives on the instance's disk; for the long-run "real system" we'll move the data into a Postgres database (Render/Railway both offer one) so it's durable and multi-user.

## Roadmap

View-only Excel dashboard (now) → accounts + persistent database → direct data entry (invoices, items) → the full accounting system, no Excel needed.
