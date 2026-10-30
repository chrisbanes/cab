---
status: accepted
---

# Provide an operator CLI through the live service

External agents need to inspect instructions and execution evidence and apply
operator-approved changes. Provide a local/private-remote CLI over cab's
service read and command layer, using dedicated revocable read-only or read/write
operator credentials. This preserves a single policy, revision and receipt
boundary across the CLI and web UI, at the cost of a machine authentication
contract and dedicated diagnostic projections; direct database access would
couple clients to storage and bypass those controls.

Authorized instruction views and bounded diagnostic capture support operational
debugging. This decision does not claim isolation from an agent
running under the operator's host account. See the
[operator CLI design](../design/operator-cli.md) for scope and acceptance.
