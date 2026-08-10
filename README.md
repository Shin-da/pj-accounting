# Perfect Jewel — Partner Sales & Accounting (pj-accounting)

A multi-user accounting dashboard for Perfect Jewel's partner sales and commission, fed by Excel uploads. Accounting admins upload each partner's data; partners see only their own report (with admin-controlled visibility); the owner sees a read-only portfolio across all partners. RDR is the first partner.

Node.js + Express + SheetJS (parsing) + Chart.js (charts). Pure JavaScript — no native build step. Accounts use scrypt-hashed passwords and signed-cookie sessions; data is scoped server-side per role.

## Run locally

```
cd pj-accounting
npm install
npm run start
```

On first run it seeds one admin account (prints a temporary password to the console) and migrates any existing dataset to the RDR partner.

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
