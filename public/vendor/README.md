# Vendored third-party scripts

Checked into the repo and served locally — not loaded from a CDN — so the app keeps working
on a fully offline standalone install.

- **jsbarcode.code128.min.js** — [JsBarcode](https://github.com/lindell/JsBarcode) v3.12.3,
  Code128-only build, MIT licensed. Used for price tag printing. Exposes a global
  `JsBarcode(element, text, options)`. To update: `npm pack jsbarcode` and pull
  `dist/barcodes/JsBarcode.code128.min.js` from the tarball.
- **qrcode.js** — [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) v2.0.4,
  MIT licensed, dependency-free, not minified (it's already small). Used for the QR code price-
  tag option. Exposes a global `qrcode(typeNumber, errorCorrectionLevel)` factory — see its own
  usage in public/app.js's printPriceTags(). To update: `npm pack qrcode-generator` and pull
  `dist/qrcode.js` from the tarball (not `qrcode_UTF8.js`/`.mjs` — those are an add-on patch and
  an ES module build, neither of which this plain-`<script>`-tag setup needs).
