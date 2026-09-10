<h1 align="center">TAK Portal</h1>

<p align="center">
TAK Portal is a lightweight, modern user-management portal designed to integrate seamlessly with Authentik and TAK Server for streamlined certificate and account control. Built for agencies who need reliability, simplicity, and security.
</p>

---

## Support My Work

It is certainly not a expected, but if you have found TAK Portal helpful to you or your agency, please consider supporting me.  My goal is to serve the TAK community and to solve real world problems.  This project while used by many state, local, and federal agencies is developed on my own time.

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-yellow?logo=buy-me-a-coffee&logoColor=black)](https://www.buymeacoffee.com/adventureseeker423)

## Architecture Overview

TAK Portal runs as a lightweight Docker container and is designed to interface with self hosted versions of:

- [**Authentik**](https://goauthentik.io/) – Identity Provider (Users, Groups, Authentication)
- [**TAK Server**](https://tak.gov/) – Situational Awareness Tool
- [**Caddy**](https://caddyserver.com/) – Reverse Proxy

---

## Prerequisites

Before installing, you should have:

- Access to a Linux/Ubuntu machine running Docker
- Access to a self-hosted instance of **Authentik**
  - [Authentik Setup Guide - Docker](https://docs.goauthentik.io/install-config/install/docker-compose/)
  - [Authentik LDAP Setup](https://docs.goauthentik.io/add-secure-apps/providers/ldap/generic_setup/)
  - [Authentik API Setup](docs/authentik-api.md)
- Access to a **TAK Server** including a webadmin.p12 and takserver.pem certificate  
  - [Connecting TAK Server to Authentik LDAP](docs/authentik-tak-server.md)
- **Caddy** or another reverse proxy service (Optional, but required if wishing to make use of Global and Agency level administrators) 
  - [Caddy Configuration](docs/caddy.md)

---

## Quick Start

**The best way to deploy TAK Portal, Authentik, and all other components is to deploy https://github.com/takwerx/infra-TAK**


For manual deployment of TAK Portal: 

On your Docker machine, run:

```
git clone https://github.com/AdventureSeeker423/TAK-Portal
```

(Optional) To set a custom web UI port (Default is 3000)
```
cd ~/TAK-Portal && ./takportal config
```

Start TAK Portal - This will install any dependencies and start the Docker container
```
cd ~/TAK-Portal && ./takportal start
```
---

## Quick Configuration

1. Open your browser and navigate to the Docker host IP and port. <br>
    &emsp; Default: `http://<server-ip>:3000` <br>
    &emsp; Example: `http://192.168.1.150:3000`
2. Open `Server Settings` (bottom of the sidebar).
3. Set the Authentik URL & Authentik API Token
4. Configure TAK Server (optional but recommended): <br>
    &emsp; - Set your TAK URL (ensure the correct port and keep /Marti at the end) <br>
    &emsp; - Upload webadmin.p12 and tak-ca.pem
    &emsp; - Provide the webadmin password (default is usually atakatak)
5. Scroll to the bottom and click *Save*.

---

## Getting Started

1. Navigate to `Manage Agencies` and create your first agency.
2. Navigate to `Groups` and create groups for your state, county, or agency.
3. Navigate to `Agency Templates` and begin creating templates for your users.
4. Navigate to `Create Users` and create your first user

---

## Additional Commands

Additional commands are included with TAK Portal to assist you in keeping your Docker container running and, more importantly, ***up-to-date*** with the latest version.  We encourage you to check regularly for updates that may address bugs and add additional features.  An update notification will show in the sidebar when updates are available.

To update TAK Portal while retaining your current settings and configuration:
```
cd ~/TAK-Portal && ./takportal update
```

To view TAK Portal Logs:
```
cd ~/TAK-Portal && ./takportal logs
```

To see all avaliable commands:
```
cd ~/TAK-Portal && ./takportal help
```

---

## Additional Guides
- [Authentik Password Reset / Self service](docs/authentik-password-portal.md)
- [FAQ](docs/faq.md)