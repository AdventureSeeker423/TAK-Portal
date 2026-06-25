# Map icon parity (CloudTAK reference)

TAK-Portal map symbology targets **CloudTAK main** behavior using **offline-bundled**
[CloudTAK-Data](https://github.com/dfpc-coe/CloudTAK-Data) iconsets (see
`assets/map-icons/MANIFEST.json`).

## Reference pin

| Item | Value |
|------|--------|
| CloudTAK repo | `https://github.com/dfpc-coe/CloudTAK` |
| Reference branch | `main` (behavioral target; not a runtime dependency) |
| Icon assets tag | CloudTAK-Data **v1.1.0** (`scripts/vendor-cloudtak-icons.js`) |
| CoT → SIDC | `@tak-ps/node-cot` `Type2525` (`/2525` export) |
| Dynamic symbols | `milsymbol` 2525D rendering when no PNG match |

## Portal architecture (efficient hybrid)

1. **Server** resolves CoT → `iconId` (`services/mapIcon.service.js` +
   `services/mapIcon.resolve.js`).
2. **Server** renders PNG tint or 2525D symbol → stable `mimg-*` id
   (`services/mapIconRender.service.js`, `services/mapMilSym.service.js`).
3. **Client** batch-loads `meta.iconManifest` via `POST /api/map/icons/rendered/batch`
   and caches in IndexedDB (`public/map.js`).

## Parity reports

- `npm run audit:icons` → `reports/icon-audit.json`
- Includes `parity` section with fixture resolution matrix

## Intentional differences

- **EUD markers** use team dots (not PNG), even when `usericon` is present.
- **No CloudTAK API hydration** — iconsets are bundled under `assets/map-icons/`.
- **2525D symbols** are generated server-side for portal map display only.
