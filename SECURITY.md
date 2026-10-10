# Security Policy

## Supported Versions

Tralyn is an independent portfolio project. Only the latest version on the `main` branch (and the latest public release, if any) receives security fixes.

## Reporting a Vulnerability

Please **do not open a public issue** for security vulnerabilities.

Report them privately instead:

1. Use GitHub's private vulnerability reporting on this repository (**Security** tab → **Report a vulnerability**), when available.
2. Otherwise, contact the maintainer through the GitHub profile [@brotherson10](https://github.com/brotherson10) and ask for a private channel, without including vulnerability details in public.

Please include a description of the issue, the steps to reproduce it and the potential impact. Give a reasonable amount of time to investigate and fix the issue before any public disclosure.

## Scope

- **In scope:** the application code, the database schema, Row Level Security policies, the movement RPC and the tooling in this repository.
- **Public demo:** any hosted demo uses fictional data only. Please do not run automated scanners, load tests or denial-of-service attempts against it, and do not try to access other users' data beyond what is needed to demonstrate an issue.
- **Shared demo account:** the read-only viewer credentials used by the public demo are public by design, and their password and e-mail are locked in the database. Knowing or using them is not a vulnerability; being able to change data, change those credentials or act beyond the viewer role is. Signing out every session of the shared account (global sign-out) is a known limitation of a shared account.
- **Out of scope:** vulnerabilities in third-party services and dependencies (please report those upstream), and issues that require physical access to a user's device.

## No Service Level Agreement

This is a portfolio project, provided as is. Reports are handled on a best-effort basis, with no guaranteed response time or production support.
