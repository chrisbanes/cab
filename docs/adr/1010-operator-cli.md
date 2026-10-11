---
status: accepted
---

# Provide an operator CLI through the live service

External agents need to inspect instructions and execution evidence and apply
operator-approved changes. Provide a local/private-remote CLI over Ensemble's
service read and command layer, using dedicated revocable read-only or read/write
operator credentials. This preserves a single policy, revision and receipt
boundary across the CLI and web UI, at the cost of a machine authentication
contract and dedicated diagnostic projections; direct database access would
couple clients to storage and bypass those controls.

Authorized instruction views and bounded diagnostic capture support operational
debugging. They are distinct from the restricted, deferred ChatGPT interface in
ADR-1006, whose exclusion of private instructions and raw logs remains intact.
This decision does not reopen that integration or claim isolation from an agent
running under the operator's host account. See the
[operator CLI design](../design/operator-cli.md) for scope and acceptance.
