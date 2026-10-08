# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** — do not open a public
issue. Use GitHub's "Report a vulnerability" (Security → Advisories) on the
upstream repository, or contact the maintainer listed on the repository profile.

Include: affected component, a description, reproduction steps, and impact.
You will get an acknowledgement as soon as possible and credit in the advisory
unless you ask to stay anonymous.

## Scope

Ponter is a zero-trust remote-access platform. Areas of particular interest:

- Authentication, token issuance/revocation, and the WebSocket ticket flow.
- The E2EE session-negotiation and peer-identity (Ed25519) verification paths.
- Input-injection gates and the sandboxed file-transfer root.
- TURN/ICE credential minting and the signaling relay.

## Supported versions

Only the latest `main` is supported. There are no maintained release branches.
