"use client";

import { useRef, useState, type FormEvent } from "react";
import { ArrowRight } from "lucide-react";
import { mySoGraphPublishRequestSchema, type MySoGraphPublishRequest } from "@/src/core/contracts/myso-knowledge-graph";

interface PublishResult { graphId: string; graphVersion: number; manifestHashHex: string; chain: { digest: string; status?: string } }

/** Owner-controlled listing form. Plain graph data is sent only to the MyData encryption/publish path. */
export function MySoGraphPublisher({ organizationId, onPublished }: { organizationId?: string; onPublished?: () => void }) {
    const [expanded, setExpanded] = useState(false);
    const [manifestText, setManifestText] = useState("");
    const [priceMist, setPriceMist] = useState("1000000");
    const [accessKind, setAccessKind] = useState<"2" | "3">("2");
    const [durationDays, setDurationDays] = useState("0");
    const [revocationPolicy, setRevocationPolicy] = useState<"one_time_perpetual" | "subscription_period_end" | "subscription_early_future_only">("one_time_perpetual");
    const [authorityKind, setAuthorityKind] = useState<"organization_admin" | "sell_graph_delegate">("organization_admin");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [result, setResult] = useState<PublishResult | null>(null);
    const retryRequest = useRef<MySoGraphPublishRequest | null>(null);

    function changed() { retryRequest.current = null; setResult(null); }
    async function publish(event: FormEvent) {
        event.preventDefault();
        if (!organizationId) { setError("Connect an agent linked to the organization that owns or delegates graph selling."); return; }
        setBusy(true); setError("");
        try {
            if (!retryRequest.current) {
                let manifest: unknown;
                try { manifest = JSON.parse(manifestText); }
                catch { throw new Error("Enter a valid GraphManifest JSON document."); }
                const now = Date.now();
                const candidate = {
                    manifest,
                    authorityProof: { kind: authorityKind, organizationId, checkedAtMs: now },
                    offerTerms: {
                        accessKind: Number(accessKind) as 2 | 3, priceMist, durationDays,
                        revocationPolicy, entitlement: "pinned_version" as const,
                        audiencePolicy: "buyer_agent_or_explicit_org" as const,
                    },
                    publishedAtMs: now,
                    idempotencyKey: crypto.randomUUID(),
                };
                const parsed = mySoGraphPublishRequestSchema.safeParse(candidate);
                if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Check the graph manifest and offer terms.");
                retryRequest.current = parsed.data;
            }
            const response = await fetch("/api/myso/knowledge/publish-graph", {
                method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
                body: JSON.stringify(retryRequest.current),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error ?? "The graph listing could not be published.");
            if (!data?.chain?.digest || !data?.manifestHashHex) throw new Error("The publisher returned an incomplete transaction receipt.");
            setResult(data as PublishResult); setManifestText(""); retryRequest.current = null; onPublished?.();
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "The graph listing could not be published.");
        } finally { setBusy(false); }
    }

    return <details className="myso-graph-publisher" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
        <summary>Publish a private graph offer</summary>
        <p className="myso-knowledge-note">The MyData service encrypts the manifest before the existing P2P listing transaction. Public listing tags expose the seller proof, manifest hash, and offer terms. Publishing requires current organization-admin or <code>sell_graph</code> delegate authority.</p>
        <form className="myso-create" onSubmit={publish}>
            <label htmlFor="graph-manifest-json">MySocial GraphManifest JSON</label>
            <textarea id="graph-manifest-json" rows={12} maxLength={190000} required value={manifestText} onChange={event => { changed(); setManifestText(event.target.value); }} disabled={busy} placeholder='{"schemaVersion":"myso.graph-manifest.v1",…}' spellCheck={false}/>
            <label htmlFor="graph-selling-authority">Selling authority</label>
            <select id="graph-selling-authority" value={authorityKind} disabled={busy} onChange={event => { changed(); setAuthorityKind(event.target.value as typeof authorityKind); }}>
                <option value="organization_admin">Organization admin</option><option value="sell_graph_delegate">sell_graph delegate</option>
            </select>
            <label htmlFor="graph-offer-price">Price in MIST base units</label>
            <input id="graph-offer-price" inputMode="numeric" pattern="[1-9][0-9]{0,19}" required value={priceMist} onChange={event => { changed(); setPriceMist(event.target.value); }} disabled={busy}/>
            <label htmlFor="graph-access-kind">Access model</label>
            <select id="graph-access-kind" value={accessKind} disabled={busy} onChange={event => {
                changed(); const next = event.target.value as "2" | "3"; setAccessKind(next);
                if (next === "2") { setDurationDays("0"); setRevocationPolicy("one_time_perpetual"); }
                else { setDurationDays("30"); setRevocationPolicy("subscription_period_end"); }
            }}>
                <option value="2">One-time · pinned immutable version</option><option value="3">Subscription</option>
            </select>
            {accessKind === "3" && <>
                <label htmlFor="graph-duration">Subscription duration in days</label>
                <input id="graph-duration" inputMode="numeric" pattern="[1-9][0-9]{0,19}" required value={durationDays} onChange={event => { changed(); setDurationDays(event.target.value); }} disabled={busy}/>
                <label htmlFor="graph-revocation">Revocation terms</label>
                <select id="graph-revocation" value={revocationPolicy} disabled={busy} onChange={event => { changed(); setRevocationPolicy(event.target.value as typeof revocationPolicy); }}>
                    <option value="subscription_period_end">Access ends with the paid period</option><option value="subscription_early_future_only">Seller may revoke future access early</option>
                </select>
                <p className="myso-knowledge-note">A subscription renews access to this immutable graph version only. Later versions are separate offers and require a separate purchase.</p>
            </>}
            {!organizationId && <p role="alert" className="myso-error">This connected agent is not linked to an organization.</p>}
            {error && <p role="alert" className="myso-error">{error}</p>}
            {result && <p role="status" className="myso-knowledge-note">Listing transaction submitted · {result.graphId} v{result.graphVersion} · manifest {result.manifestHashHex.slice(0, 16)}… · transaction {result.chain.digest}. Indexer discovery may take time.</p>}
            <button className="myso-primary" disabled={busy || !organizationId || !manifestText.trim()}>{busy ? "Encrypting and publishing…" : "Encrypt and publish offer"}<ArrowRight size={16}/></button>
        </form>
    </details>;
}
