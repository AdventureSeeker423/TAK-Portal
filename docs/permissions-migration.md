# Granular permissions — migration checklist

## What changed

- **Roles** are unchanged: **standard**, **agency admin** (from `agencies` + Authentik groups), and **global admin** (`PORTAL_AUTH_REQUIRED_GROUP`).
- **Capabilities** are defined in `services/permissions.registry.js` with **defaults per role** that match the previous route allowlists.
- **Per-user deny overrides** are stored in `data/permission-overrides.json` (created on first save; the file is typically gitignored with other `data/*.json`).
- **Path checks** in `services/portalAuth.middleware.js` use the registry’s path → permission map. Legacy “public to any logged-in user” paths (`/`, `/dashboard`, setup device, high-res QR download, static assets) still skip extra capability checks.
- **Route handlers** in `server.js` use `requirePermission("...")` so behavior stays aligned with overrides.
- **Access control** UI: `GET /access-control` (capability `page.access_control`, **global by default**).

## Pre-deploy

1. Ensure the `data/` directory exists and is writable (overrides and other portal data).
2. No migration script is required: an empty or missing `permission-overrides.json` means “no overrides” (role defaults only).

## Verification matrix (smoke)

| Persona        | Example paths / expectation |
|----------------|-----------------------------|
| Standard       | `/setup-my-device`, `/plugins`, plugin download & enrollment APIs; not `/users`, `/settings`. |
| Agency admin   | Same as before: users/groups/templates/email/pending requests/documents APIs, **GET** `/api/agencies` only; not `/agencies` page, not `/settings`, not audit. |
| Global admin   | Full catalog unless denied via overrides. |
| Overrides      | Deny e.g. `page.settings` for a global admin → `/settings` and related APIs return 403 after save. |

## API notes

- `GET/PUT /api/access-control/*` require `page.access_control` (and Authentik auth when enabled).
- `PUT /api/access-control/overrides/:username` body: `{ "deny": ["page.settings", ...] }` (valid ids only).
- Effective access for **another** user is resolved with Authentik (group names) + the same role rules as the portal.

## Renames

- The old `requireGlobalAdmin` helper in `server.js` (which allowed **global or agency** admins) is replaced by **`requirePermission("…")`**. There is no remaining symbol with that misleading name in `server.js`.
