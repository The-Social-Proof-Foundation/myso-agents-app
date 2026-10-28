# MySocial private knowledge graph

Private graph data uses a versioned MySocial `GraphManifest` in an encrypted MyData record. The reader validates typed graph structure, signed publication metadata, immutable manifest hash, coverage keys, encryption-envelope references, and seller-claimed `source_rights`. The seller signature covers the manifest, including each entity/evidence source claim; separate source-owner grant records are not required. The signature is a seller assertion, not independent proof that the underlying source rights are true. The live check confirms the seller currently has organization-admin or `sell_graph` delegate authority. Public graph-offer discovery remains active as a metadata-only indexer preview, with stale/unverified labeling in MCP and the Knowledge screen. It does not establish content truth or graph quality.

Listings pin one immutable manifest version; a recurring MyData subscription renews access to that same listing. Later graph versions are separate offers and require separate purchases. There is no `latest` alias or graph-series entitlement because the current native key-release policy cannot enforce one. Legacy `series_stream` capsules remain parseable but are rejected at offer verification and purchase; sellers must republish pinned-version offers. Every entity and evidence source must be covered by a seller-signed `sell_graph` claim. Purchases verify the current MyData quote and live organization authority, and require an explicit organization audience when an organization is buying. Public previews are metadata-only. The seller form, MCP tool, authenticated server route, bounded durable encryption cache and existing MyData listing transaction are wired in source. Purchase history is recoverable by owner and agent with exact fullnode receipt verification; owner grant/revoke history is recovered from the account/agent journal and checked against chain events. Purchase, grant and revoke wallet-operation metadata can resume after reload without persisting signatures or private keys. Deployment validation and owner end-to-end checks remain open; downstream derived-data and model-provider retention controls remain open. Already decrypted/exported data cannot be recalled.

```json
{
  "schemaVersion": "myso.graph-manifest.v1",
  "graphId": "team-knowledge",
  "graphVersion": 1,
  "title": "Example graph",
  "entities": [{
    "id": "task-42",
    "kind": "task",
    "label": "Review launch proposal",
    "statement": "The launch proposal needs security review.",
    "aliases": ["launch review"],
    "evidenceIds": ["evidence-1"],
    "state": "asserted"
  }],
  "relations": [],
  "evidenceRefs": [{
    "id": "evidence-1",
    "kind": "task_receipt",
    "sourceId": "task-market:task-42",
    "sourceVersion": "1",
    "receiptId": "receipt-id",
    "visibility": "private",
    "derivationEvidenceIds": [],
    "state": "verified",
    "recordedAt": "2026-10-25T00:00:00.000Z"
  }],
  "provenance": [{
    "id": "provenance-1",
    "subjectType": "node",
    "subjectId": "task-42",
    "evidenceId": "evidence-1",
    "actor": "agent",
    "recordedAt": "2026-10-25T00:00:00.000Z",
    "state": "asserted"
  }],
  "coverageKeys": ["task-42"],
  "encryptionEnvelopeRefs": ["sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  "sourceRights": [{
    "entityId": "task-42",
    "evidenceRefIds": ["evidence-1"],
    "sourceOwnerAddress": "0x1234",
    "license": "organization-internal",
    "permissions": ["read", "derive", "publish", "sell_graph"],
    "expiresAtMs": null
  }]
}
```

Node kinds are `concept`, `person`, `organization`, `task`, `claim`, `artifact`, and `room`. Edge kinds are `related_to`, `supports`, `contradicts`, `depends_on`, `assigned_to`, `member_of`, `participates_in`, `references`, `derived_from`, `created_by`, `delivered_to`, `published_in`, `owns`, `completed_by`, and `originates_from`. Evidence kinds are `task_receipt`, `action_receipt`, `artifact`, `room_message`, `owner_assertion`, and `external_source`; evidence state can be `asserted`, `verified`, `disputed`, `superseded`, or `revoked`. A graph's state fields are claims stored in that private document. Verify important receipts through the corresponding MySo receipt reader.

Current SDK schema limits: 2,000 entities, 10,000 relations, 10,000 evidence references, 20,000 provenance records, 262,144 Unicode scalars and 1 MiB of serialized UTF-8; listing currently imposes a tighter 180 KiB document limit. IDs are unique across graph records, references must resolve, and records reject unknown fields. Search returns at most 20 matching entities. The web/desktop Knowledge view can open a selected entity and its bounded neighborhood through `/api/myso/knowledge/graph-item`; it stays transient and is not sent to a coordinator. A signed GraphManifest reader validates entity and evidence source-rights coverage, Ed25519 seller binding, immutable manifest hash, signed offer terms against the live chain quote, and current organization selling authority from fullnode state. New publication capsule v2 signs graph ID and version as well as offer terms; each purchase identifies one immutable graph version. Subscriptions renew access to that same MyData listing; later graph versions are separate offers and require separate purchases. Legacy `series_stream` capsules remain parseable for compatibility but fail closed at offer verification and purchase. Legacy capsule v1 and unsigned graph listings remain previewable, but only signed proofs can be purchased. The server repeats signature, quote and authority checks at transaction preparation so a direct MCP action cannot bypass them. The seller UI and direct MCP publication flow sign, encrypt and create the existing MyData listing in source. Buyers can select an organization audience on a bounded MyData purchase; every key request checks the paid entitlement, current agent capability/organization ancestry, and live `OrgMemoryReader` permission against that graph’s ciphertext and encryption identity. This source-level enforcement remains deployment-gated until the updated Move package and key-server PTB policy are deployed and validated. Purchase history, owner grant/revoke history, and wallet-operation resume metadata are available in source. Remaining source privacy work is downstream derived-data/model-provider retention control; deployment and runtime behavior need owner verification. No graph-series entitlement is advertised because the user selected immutable per-purchase snapshots. Do not infer organization graph access from membership or indexer data.
