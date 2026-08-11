# Design discussion — uploads, editing, versions, files

Written before building, deliberately. The decision in §1 shapes everything else.

---

## 1. The question that matters: what is the source of truth?

Right now **Excel is the truth** and the database is a copy of the last upload.
The moment admins can *edit inside the system*, there are two sources of truth — and
they will diverge. Not might: will. Someone fixes a row in the app, Brandon re-uploads
next week, the fix silently disappears, and nobody notices until the numbers are wrong
in front of RDR.

So before anything else, pick a model.

### Model A — Excel is truth *(what we have)*
Upload replaces everything. No editing in-app.

- ✅ Simple, predictable, matches how Brandon actually works today
- ✅ One place to fix things: the spreadsheet
- ❌ No way to correct anything without going back to Brandon
- ❌ Every fix has a human round trip

### Model B — Database is truth *(a real ERP)*
Data is created and edited in the app. Excel becomes import-once, then export-only.

- ✅ Proper audit trail, validation, no re-upload dance
- ✅ Where this ends up eventually
- ❌ Brandon still lives in Excel — you'd be asking the business to change how it works
- ❌ Much bigger build, and premature while the columns are *still changing weekly*

### Model C — Excel is truth + **corrections layer** *(recommended)*
Uploads keep replacing the base data. Admins can't edit imported rows — but they can
attach **corrections and notes** that are stored separately and survive re-upload.

- ✅ No divergence: base data always matches the latest Excel
- ✅ Real problems get fixed *now* (see below) without waiting on Brandon
- ✅ Reversible, and a natural stepping stone to Model B later
- ❌ Slightly more concept to explain ("this value was corrected")

**Why C fits your actual problems**, which are not "I want to edit cells":

| Real problem you've already hit | What a corrections layer does |
|---|---|
| `JASMIN` vs `JASMIN PEDROSA`, `CAROL` vs `CAROL ZAMORA` splitting one client into two | a **client alias map** — merges them in every report, survives re-upload |
| August sheet has March–June dates (dd/mm vs mm/dd) | a **date correction** on those rows, flagged and logged |
| A row is disputed / under review | a **note + status flag** visible to admins |
| Commission missing for August | **derived/override values**, clearly marked as such |

None of those want cell editing. They want *a layer on top that doesn't get wiped.*

> **My recommendation: Model C.** Keep Excel as truth, add corrections + aliases.
> Revisit Model B only once the Excel format stops changing and someone actually
> wants to enter data directly.

---

## 2. Version history — yes, build this

Already half-done: every upload creates a `datasets` row, newest marked `is_current`.
What's missing is the UI and the useful parts.

**What to build**
- **Version list** per partner: file name, who uploaded, when, row count, current flag
- **Restore**: make an older version current again (one click, logged)
- **Diff between versions** — *the genuinely valuable one*: rows added / removed /
  changed between the last upload and this one, and the change in totals

That diff is the answer to "why did the number move?" — the question you will be asked
most often, and the hardest to answer today.

**Retention:** keep everything for now (a 75 KB file × 100 uploads is 7.5 MB — nothing).
Revisit if it ever matters.

---

## 3. Store the original Excel files — yes

Right now we parse the file and throw the original away. Keep it:

- **Download any past upload** — proof of what was submitted, and when
- Re-parse an old file if the parser improves or a bug is found
- Answers "what exactly did Brandon send on 11 Aug?" without hunting through chat

**Where:** in Postgres alongside the dataset row, as `bytea`. At ~75 KB per file this is
trivial, and it keeps one thing to back up. Move to object storage (Supabase Storage /
S3) only if these grow into hundreds of megabytes.

**Who can download:** admins and the owner. **Not partners** — the raw file contains
supplier and cost columns that partners must never see. This is important: it would be
an embarrassing way to leak exactly what we spent all that effort hiding.

---

## 4. "File holders viewable online"

Worth splitting into two different needs:

**(a) Source files** — the uploaded Excel. Covered in §3.

**(b) Supporting documents** — invoice photos (already done), and possibly receipts,
transmittals, signed acknowledgements. A general "attachments" concept, per invoice or
per partner, would cover it: a table of files with a type, uploaded-by, and a scoped
download route.

Same rule as everything else: **who can see it is decided server-side**, not by hiding
a button.

---

## 5. Things not on your list that I'd add

**Validate before committing an upload.** Right now a bad file becomes live instantly.
Better: upload → **preview screen** showing row count, date range, totals, and warnings
→ *then* confirm. Warnings worth having, all from real problems you've already found:

- dates outside the expected period (the March-in-August case)
- duplicate invoice + PJ code combinations
- rows with zero or negative amounts
- unusually large swings vs the previous version (e.g. totals ±30%)
- client names that look like variants of an existing client

This is the highest-value thing in this whole list. It's the difference between
"the report is wrong and RDR noticed" and "the system refused to publish it."

**An upload log.** Who uploaded what, when, and what changed. You'll want it the first
time two admins disagree about what happened.

---

## 6. Suggested build order

1. **Store the original file** with each upload *(small, immediately useful)*
2. **Version history UI** — list + restore *(the schema already supports it)*
3. **Upload preview + validation warnings** *(highest value, prevents bad data going live)*
4. **Client alias map** *(fixes a real, current problem)*
5. **Version diff** *(answers "why did the number change?")*
6. **Corrections layer** — notes, flags, value overrides *(only after 1–5 prove useful)*
7. Model B / direct data entry — **not yet**

Do 1–3 first. That's maybe a day's work and covers most of the pain.

---

## 7. Open questions for you

1. **Does anyone actually want to type data in, or do they want Excel to keep being the
   input?** If Brandon keeps building the sheet, Model C is right. If Tatay wants staff
   entering invoices directly, that's Model B and a much bigger conversation.
2. **Should the owner see the raw Excel files, or only admins?**
3. **Do partners ever need to upload anything** (e.g. RDR submitting their own proof of
   sale), or is upload strictly ours?
4. **What should happen to an in-app correction when a new upload arrives** — keep it
   silently, or flag it for review ("this row changed in the new file, your correction
   may no longer apply")? I'd favour flagging.
5. **How long do we keep old versions?** My default: forever, until it's a problem.
