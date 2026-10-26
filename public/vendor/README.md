# Vendored third-party scripts

Checked into the repo and served locally — not loaded from a CDN — so the app keeps working
on a fully offline standalone install.

- **jsbarcode.code128.min.js** — [JsBarcode](https://github.com/lindell/JsBarcode) v3.12.3,
  Code128-only build, MIT licensed. Used for price tag printing. Exposes a global
  `JsBarcode(element, text, options)`. To update: `npm pack jsbarcode` and pull
  `dist/barcodes/JsBarcode.code128.min.js` from the tarball.
