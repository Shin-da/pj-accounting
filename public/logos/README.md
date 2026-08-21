# Partner logos (permanent)

Drop a partner's logo here named after their slug, e.g. `rdr.png`, then commit it.
Supported: .png .jpg .jpeg .webp .gif .svg

Why here? Files in this folder ship with the code, so they survive every deploy.
Logos uploaded through the Partners admin screen land in `data/` instead, which
is wiped on each redeploy on a free host. Upload for a quick change; commit the
file here once the logo is final.

An uploaded logo takes priority over the committed one.

## `pj-logo.png` is reserved

That file is the Perfect Jewel mark shown in the header for admin/owner/
superadmin accounts (see `renderBrandMark()` in `public/app.js`) — it is
served directly as a static file, not through the partner-logo lookup.
Don't give a partner the slug `pj-logo`; a file named after it here would
collide with this one.
