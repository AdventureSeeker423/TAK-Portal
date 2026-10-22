<h1 align="center">TAK Portal</h1>

<p align="center">
  <strong>User management for Authentik and TAK Server</strong><br>
  Certificate enrollment, agency administration, and account control — built for public safety and government agencies.
</p>

<p align="center">
  <a href="https://www.buymeacoffee.com/adventureseeker423"><img src="https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-yellow?logo=buy-me-a-coffee&logoColor=black" alt="Buy Me A Coffee"></a>
  <img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License">
</p>

---

## Recommended Installation: InfraTAK

**The recommended way to deploy TAK Portal is with [InfraTAK](https://github.com/takwerx/infra-TAK).**

InfraTAK is a browser-based infrastructure platform that deploys TAK Server, Authentik, and TAK Portal together — with automated LDAP, SSL, and QR enrollment. It also includes CloudTAK, MediaMTX, and Node-RED.

If you are standing up a new environment, start there. Manual installation of TAK Portal alone is supported for advanced or existing stacks, but InfraTAK is the path we recommend for most agencies.

| | InfraTAK | Manual TAK Portal |
|---|---|---|
| TAK Server + Authentik + Portal | One-click stack | You assemble each piece |
| LDAP / SSL / enrollment | Automated | Manual configuration |
| Best for | New deployments | Existing Docker hosts |

**→ [Deploy with InfraTAK](https://github.com/takwerx/infra-TAK)**

---

## Support This Project

TAK Portal is used by state, local, and federal agencies. It is developed on personal time to serve the TAK community and solve real operational problems.

Support is never expected — but if the project has helped you or your agency, consider buying me a coffee.

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-yellow?logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/adventureseeker423)

---

## What TAK Portal Does

TAK Portal is a lightweight Docker application that sits between Authentik and TAK Server. It provides a modern admin UI for:

- User and certificate lifecycle management
- Agency, group, and template administration
- Client enrollment and device setup flows
- Operational features such as Mutual Aid, Data Sync, and integrations

Designed for agencies that need reliability, simplicity, and security without unnecessary complexity.

---

## Architecture

TAK Portal runs as a Docker container and integrates with self-hosted:

| Component | Role |
|---|---|
| [Authentik](https://goauthentik.io/) | Identity provider — users, groups, authentication |
| [TAK Server](https://tak.gov/) | Situational awareness platform |
| [Caddy](https://caddyserver.com/) | Reverse proxy (optional; required for Global and Agency admin features) |

---

## Manual Installation

Use this path only if you already operate Authentik and TAK Server, or you cannot use InfraTAK.

### Prerequisites

- Linux host with Docker
- Self-hosted [Authentik](https://docs.goauthentik.io/install-config/install/docker-compose/)
  - [Authentik LDAP setup](https://docs.goauthentik.io/add-secure-apps/providers/ldap/generic_setup/)
  - [Authentik API setup](docs/authentik-api.md)
- TAK Server with `webadmin.p12` and CA certificate (`tak-ca.pem` / `takserver.pem`)
  - [Connect TAK Server to Authentik LDAP](docs/authentik-tak-server.md)
- Caddy or another reverse proxy (optional; required for Global and Agency administrators)
  - [Caddy configuration](docs/caddy.md)

### Install & Start

```bash
git clone https://github.com/ValleyTacticalSolutions/TAK-Portal
cd TAK-Portal
```

Optional — set a custom UI port (default `3000`):

```bash
./takportal config
```

Start TAK Portal (installs dependencies and starts the container):

```bash
./takportal start
```

### Initial Configuration

1. Open `http://<server-ip>:3000` (or your configured port).
2. Open **Server Settings** (bottom of the sidebar).
3. Set the Authentik URL and Authentik API token.
4. Configure TAK Server (recommended):
   - TAK URL (include the correct port; keep `/Marti` at the end)
   - Upload `webadmin.p12` and `tak-ca.pem`
   - Provide the webadmin password (often `atakatak` by default)
5. Click **Save**.

### First Steps

1. **Manage Agencies** — create your first agency.
2. **Groups** — create groups for your state, county, or agency.
3. **Agency Templates** — define templates for your users.
4. **Create Users** — enroll your first user.

---

## Maintenance Commands

Keep TAK Portal updated. An in-app notification appears in the sidebar when a newer version is available.

| Command | Description |
|---|---|
| `./takportal update` | Update while retaining settings and configuration |
| `./takportal logs` | View container logs |
| `./takportal help` | List all available commands |

```bash
cd ~/TAK-Portal
./takportal update
./takportal logs
./takportal help
```

---

## Additional Guides

- [Authentik password reset / self-service](docs/authentik-password-portal.md)
- [FAQ](docs/faq.md)

---

## License

Licensed under the [AGPL-3.0](LICENSE).
