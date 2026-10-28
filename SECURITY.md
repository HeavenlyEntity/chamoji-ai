# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Report them privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability**. We aim to reply within 3 working days, and we'll keep you updated until it's fixed.

Include:

- the chamoji version (`chamoji --version`)
- what you ran
- what happened
- what an attacker could do with it

## What's in scope

- **Command or argument injection** through git refs, config files or commit text.
- **Output that injects HTML, scripts or links** into generated changelogs.
- **Data leaving the machine beyond what the readme documents:**
  - the daily update check
  - `--ai` requests: subjects and trimmed bodies, with emails and trailers removed
- **Secrets being read or printed,** such as a `TYPESAFE_API_KEY` or other `.env` values.

## Supported versions

Security fixes go into the latest release. Update with `npm i -g @chamoji/cli@latest`.
