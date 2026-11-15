# Security policy

## Supported versions

The latest release on the `main` branch is supported. Pre-release versions are provided for
testing only.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private
vulnerability reporting:

<https://github.com/T-splines/dsh-compaction-policy-engine/security/advisories/new>

Include the affected version, a minimal reproduction and the impact you observed. You will
get an acknowledgement as soon as possible; please allow time for a fix and a coordinated
disclosure.

## Scope

This plugin runs inside the DSH host. It reads compaction policy from the profile patch and
`settings.yaml`, and delegates summarization to the configured LLM routes. It does not store
API keys or conversation content in this repository. The settings panel follows DSH's
loopback-only write model: non-loopback browsers receive a read-only memory-state view.
Vulnerabilities in DSH itself or in a third-party model provider should be reported to that
project.
