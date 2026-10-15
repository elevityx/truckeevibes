# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through **GitHub private vulnerability reporting**: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue, pull request, or discussion for a security problem.

Please include what you found, steps to reproduce, and the impact you believe it has. We will acknowledge the report, work with you on a fix, and credit you in the fix if you would like.

## Scope

In scope:

- the truckeevibes.com site
- the code and database migrations in this repository (for example row-level security, grants, the source permission gate, and the ingest path)

Out of scope:

- third-party services we depend on (report those to their vendors)
- bad or spam event data that the moderation tools already handle
- denial-of-service through sheer traffic volume
- findings that require a compromised device or account

Organizers who want a source or event removed should use the opt-out address on [the bot page](https://truckeevibes.com/bot/), not this process.

## Testing guidelines

Test against a local Supabase stack (see [CONTRIBUTING.md](CONTRIBUTING.md)), not the live site. Do not access, change, or delete data that is not yours, and do not degrade the service for others.

## Bounties

This is a volunteer community project and does not offer a bounty.
