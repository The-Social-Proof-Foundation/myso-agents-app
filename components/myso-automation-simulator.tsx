"use client";

import { useState, type FormEvent } from "react";

export interface AutomationSimulationResult {
    jobId: string;
    eventFamily: string;
    eventType: string;
    matchedTriggerIndexes: number[];
    eventTriggerCount: number;
    nonEventTriggerCount: number;
    eventOnlyWouldSatisfyTriggerSet: boolean;
    dispatchPerformed: false;
    persisted: false;
    limitations: string[];
}

export function MySoAutomationSimulator({ jobs, disabled, onSimulate }: {
    jobs: Array<{ id: string; name: string }>;
    disabled: boolean;
    onSimulate: (jobId: string, request: { event_family: string; event_type: string; payload: Record<string, unknown> }) => Promise<AutomationSimulationResult>;
}) {
    const [jobId, setJobId] = useState("");
    const [family, setFamily] = useState("");
    const [eventType, setEventType] = useState("");
    const [payloadText, setPayloadText] = useState("{}");
    const [result, setResult] = useState<AutomationSimulationResult | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault(); setError(""); setResult(null);
        let payload: unknown;
        try { payload = JSON.parse(payloadText); }
        catch { setError("Event payload must be valid JSON."); return; }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) { setError("Event payload must be a JSON object."); return; }
        if (!jobId) { setError("Choose an automation to simulate."); return; }
        setBusy(true);
        try { setResult(await onSimulate(jobId, { event_family: family, event_type: eventType, payload: payload as Record<string, unknown> })); }
        catch (reason) { setError(reason instanceof Error ? reason.message : "The event could not be simulated."); }
        finally { setBusy(false); }
    }

    return <section className="myso-settlement-receipt" aria-label="Simulate automation event">
        <h3>Preview an event</h3>
        <p>This is a matching preview only. It never writes a delivery or executes the job action.</p>
        <form className="myso-automation-create" onSubmit={event => void submit(event)}>
            <label htmlFor="automation-sim-job">Automation</label>
            <select id="automation-sim-job" value={jobId} disabled={disabled || busy} onChange={event => setJobId(event.target.value)}><option value="">Choose an automation</option>{jobs.map(job=><option key={job.id} value={job.id}>{job.name}</option>)}</select>
            <label htmlFor="automation-sim-family">Event family</label><input id="automation-sim-family" value={family} maxLength={128} required disabled={busy} onChange={event=>setFamily(event.target.value)} placeholder="task"/>
            <label htmlFor="automation-sim-type">Event type</label><input id="automation-sim-type" value={eventType} maxLength={128} required disabled={busy} onChange={event=>setEventType(event.target.value)} placeholder="offered"/>
            <label htmlFor="automation-sim-payload">Event payload JSON (maximum 32 KiB)</label><textarea id="automation-sim-payload" value={payloadText} maxLength={48000} rows={6} spellCheck={false} disabled={busy} onChange={event=>setPayloadText(event.target.value)}/>
            {error&&<p className="myso-error" role="alert">{error}</p>}
            {result&&<div className="myso-verified-receipt"><strong>{result.eventOnlyWouldSatisfyTriggerSet?"This sample satisfies the event-only trigger set":"This sample does not satisfy the trigger set by itself"}</strong><span>Matched trigger indexes: {result.matchedTriggerIndexes.length?result.matchedTriggerIndexes.join(", "):"none"}</span><span>Event triggers: {result.eventTriggerCount} · non-event triggers: {result.nonEventTriggerCount}</span><span>Dispatch: none · persisted: no</span>{result.limitations.map((limitation,index)=><small key={index}>{limitation}</small>)}</div>}
            <div className="myso-toolbar"><button className="myso-primary" type="submit" disabled={disabled||busy||jobs.length===0||!jobId||!family.trim()||!eventType.trim()}>{busy?"Evaluating…":"Simulate without dispatch"}</button></div>
        </form>
    </section>;
}
