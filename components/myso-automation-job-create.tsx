"use client";

import { useMemo, useRef, useState } from "react";

export interface AutomationJobDelegate {
    delegate_ref: string;
    delegate_class: "memory" | "task_worker" | "juror" | "action_worker";
    allowed_action_ids: string[];
    chainStatus: { status: "unavailable" } | { status: "active" | "inactive" };
}

export interface AutomationJobCreateInput {
    name: string;
    delegateRef: string;
    triggerKind: "event" | "cron" | "interval";
    eventType: string;
    cronExpr?: string;
    timezone?: string;
    intervalMs?: number;
    actionId: string;
    actionConfig: Record<string, unknown>;
}

export interface AutomationJobValidation {
    valid: true;
    action_kind: string;
    trigger_count: number;
    enabled_on_create: boolean;
    dispatch_performed: false;
    notice: string;
}

export interface AutomationWorkModel {
    id: string;
    display_name: string;
    max_output_tokens: number | null;
    supports_tools: boolean;
}

const CREATE_REQUEST_STORAGE_KEY = "myso-agents:automation-create:pending";
async function createRequestFingerprint(value: string): Promise<string> {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function MySoAutomationJobCreate({ delegates, models, loading, onCreate, onValidate }: {
    delegates: AutomationJobDelegate[] | null;
    models: AutomationWorkModel[];
    loading: boolean;
    onCreate: (input: AutomationJobCreateInput, idempotencyKey: string) => Promise<void>;
    onValidate: (input: AutomationJobCreateInput) => Promise<AutomationJobValidation>;
}) {
    const [name, setName] = useState("");
    const [delegateRef, setDelegateRef] = useState("");
    const [triggerKind, setTriggerKind] = useState<AutomationJobCreateInput["triggerKind"]>("event");
    const [eventType, setEventType] = useState("");
    const [cronExpr, setCronExpr] = useState("0 9 * * *");
    const [timezone, setTimezone] = useState("UTC");
    const [intervalMs, setIntervalMs] = useState(3600000);
    const [actionId, setActionId] = useState("");
    const [actionConfigText, setActionConfigText] = useState('{\n  "params": {},\n  "policy": {}\n}');
    const [workRunId, setWorkRunId] = useState("");
    const [workModelId, setWorkModelId] = useState("");
    const [workMaxTurns, setWorkMaxTurns] = useState(3);
    const [workMaxTokens, setWorkMaxTokens] = useState(2048);
    const [allowRoomHistory, setAllowRoomHistory] = useState(false);
    const [allowPrivateGraph, setAllowPrivateGraph] = useState(false);
    const [allowPrivateTaskArtifacts, setAllowPrivateTaskArtifacts] = useState(false);
    const [allowPrivateContentSharing, setAllowPrivateContentSharing] = useState(false);
    const [confirmEnabled, setConfirmEnabled] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [validation, setValidation] = useState<{ signature: string; result: AutomationJobValidation } | null>(null);
    const createRequest = useRef<{ signature: string; idempotencyKey: string } | null>(null);
    const activeDelegates = useMemo(() => (delegates ?? []).filter(item =>
        item.chainStatus.status === "active" && (item.delegate_class === "task_worker" || item.delegate_class === "juror" || item.delegate_class === "action_worker")
    ), [delegates]);
    const selected = activeDelegates.find(item => item.delegate_ref === delegateRef);
    const actionIds = selected?.delegate_class === "action_worker" ? [...(selected.allowed_action_ids ?? []), "myso.work_run.v1"] : selected?.allowed_action_ids ?? [];
    const durableWork = actionId === "myso.work_run.v1";
    const signature = JSON.stringify({ name, delegateRef, triggerKind, eventType, cronExpr, timezone, intervalMs, actionId, actionConfigText, workRunId, workModelId, workMaxTurns, workMaxTokens, allowRoomHistory, allowPrivateGraph, allowPrivateTaskArtifacts, allowPrivateContentSharing });

    function collectInput(): AutomationJobCreateInput | null {
        if (!selected) { setError("Choose a delegate with active on-chain authority."); return null; }
        if (triggerKind === "event" && !eventType.trim()) { setError("Enter the exact task or jury event type."); return null; }
        if (triggerKind === "cron" && (!cronExpr.trim() || !timezone.trim())) { setError("Enter a cron expression and IANA timezone."); return null; }
        if (triggerKind === "interval" && (!Number.isSafeInteger(intervalMs) || intervalMs < 60000)) { setError("Choose an interval of at least 60 seconds."); return null; }
        let actionConfig: Record<string, unknown>;
        if (actionId === "myso.work_run.v1") {
            const model = models.find(item => item.id === workModelId && item.supports_tools && item.max_output_tokens !== null);
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workRunId)) { setError("Enter the ID of an existing encrypted work run."); return null; }
            if (!model) { setError("Choose a currently available MySo model with tool support."); return null; }
            if (workMaxTokens < 1 || workMaxTokens > (model.max_output_tokens ?? 0)) { setError("Output tokens must fit the selected model's published limit."); return null; }
            if (workMaxTurns < 1 || workMaxTurns > 100) { setError("Model turns must be between 1 and 100."); return null; }
            actionConfig = { runId: workRunId, turn: { modelId: workModelId, maxModelTurns: workMaxTurns, maxOutputTokens: workMaxTokens, allowRoomHistory, allowPrivateGraph, allowPrivateTaskArtifacts, allowPrivateContentSharing } };
        } else {
            try {
                const parsed: unknown = JSON.parse(actionConfigText);
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Enter a JSON object.");
                actionConfig = parsed as Record<string, unknown>;
            } catch (reason) {
                setError(reason instanceof Error ? reason.message : "Action configuration must be a JSON object."); return null;
            }
        }
        return { name: name.trim(), delegateRef, triggerKind, eventType: eventType.trim(), ...(triggerKind === "cron" ? { cronExpr: cronExpr.trim(), timezone: timezone.trim() } : {}), ...(triggerKind === "interval" ? { intervalMs } : {}), actionId, actionConfig };
    }

    async function validate() {
        setError(""); setNotice("");
        const input = collectInput(); if (!input) return;
        setSubmitting(true);
        try {
            const result = await onValidate(input);
            setValidation({ signature, result });
            setNotice("Preflight passed. No job was created and no action was dispatched. Review the settings, then create the enabled job when ready.");
        } catch (reason) {
            setValidation(null);
            setError(reason instanceof Error ? reason.message : "Preflight failed; no job was created.");
        } finally { setSubmitting(false); }
    }

    async function submit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setError(""); setNotice("");
        const input = collectInput(); if (!input) return;
        if (!validation || validation.signature !== signature || !validation.result.valid) { setError("Validate this exact setup before creating the job."); return; }
        setSubmitting(true);
        try {
            if (!confirmEnabled) { setError("Confirm that this automation will start enabled and may act on its event or schedule."); return; }
            const fingerprint = await createRequestFingerprint(signature);
            let pendingFingerprint: string | null = null;
            let pendingKey: string | null = null;
            try {
                const raw = sessionStorage.getItem(CREATE_REQUEST_STORAGE_KEY);
                if (raw) {
                    const value: unknown = JSON.parse(raw);
                    if (value && typeof value === "object") {
                        const record = value as Record<string, unknown>;
                        if (typeof record.fingerprint === "string") pendingFingerprint = record.fingerprint;
                        if (typeof record.idempotencyKey === "string") pendingKey = record.idempotencyKey;
                    }
                }
            } catch { /* The in-memory retry key still protects this mounted form. */ }
            const storedKey = pendingFingerprint === fingerprint && pendingKey
                && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pendingKey)
                ? pendingKey : null;
            const requestKey = createRequest.current?.signature === fingerprint
                ? createRequest.current.idempotencyKey
                : storedKey ?? crypto.randomUUID();
            createRequest.current = { signature: fingerprint, idempotencyKey: requestKey };
            try { sessionStorage.setItem(CREATE_REQUEST_STORAGE_KEY, JSON.stringify({ fingerprint, idempotencyKey: requestKey })); } catch { /* Server idempotency still protects retries while this form is mounted. */ }
            await onCreate(input, requestKey);
            createRequest.current = null;
            try { sessionStorage.removeItem(CREATE_REQUEST_STORAGE_KEY); } catch { /* The old key is bound to the same setup and remains safe to retry. */ }
            setNotice("Automation created. Review its trigger, action, and turn settings in the list.");
            setName(""); setEventType(""); setActionConfigText('{\n  "params": {},\n  "policy": {}\n}'); setWorkRunId(""); setAllowRoomHistory(false); setAllowPrivateGraph(false); setAllowPrivateTaskArtifacts(false); setAllowPrivateContentSharing(false); setConfirmEnabled(false); setValidation(null);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "Automation creation could not be confirmed. Retry the unchanged setup to safely resume the same request.");
        } finally { setSubmitting(false); }
    }

    return <section className="myso-settlement-receipt" aria-label="Create automation">
        <div className="myso-market-sellers-heading"><div><p className="myso-eyebrow">NEW AUTOMATION</p><h2>Create an automation</h2></div></div>
        <p>Jobs start enabled as soon as they are accepted. The server binds the event family and agent to the selected delegate, then checks its live chain status and action permissions. Use the exact indexed event type. If the response is lost, retry the unchanged setup to receive the original job instead of creating a duplicate.</p>
        <form className="myso-automation-create" onSubmit={event => void submit(event)}>
            <label htmlFor="automation-create-name">Name</label>
            <input id="automation-create-name" value={name} maxLength={200} required onChange={event => setName(event.target.value)} placeholder="Task review agent" />
            <label htmlFor="automation-create-delegate">Active signing delegate</label>
            <select id="automation-create-delegate" value={delegateRef} required disabled={loading || !activeDelegates.length} onChange={event => { setDelegateRef(event.target.value); setActionId(""); }}>
                <option value="">{loading ? "Checking delegates…" : "Choose a task-worker, juror, or action-worker delegate"}</option>
                {activeDelegates.map(item => <option key={item.delegate_ref} value={item.delegate_ref}>{item.delegate_ref} · {item.delegate_class}</option>)}
            </select>
            {selected && <>
                <label htmlFor="automation-create-action">Authorized action</label>
                <select id="automation-create-action" value={actionId} required onChange={event => setActionId(event.target.value)}>
                    <option value="">Choose an action this delegate can run</option>
                    {actionIds.map(id => <option key={id} value={id}>{id}</option>)}
                </select>
                <label htmlFor="automation-create-trigger-kind">When should it run?</label>
                <select id="automation-create-trigger-kind" value={triggerKind} onChange={event => { setTriggerKind(event.target.value as AutomationJobCreateInput["triggerKind"]); setValidation(null); }}>
                    <option value="event">When a task or jury event occurs</option><option value="cron">On a schedule (cron)</option><option value="interval">At a repeating interval</option>
                </select>
                {triggerKind === "event" ? <><label htmlFor="automation-create-event">Exact event type</label>
                    <input id="automation-create-event" value={eventType} maxLength={128} required onChange={event => setEventType(event.target.value)} placeholder={selected.delegate_class === "juror" ? "jury event type" : "task event type"} />
                    <small>Event family is bound to {selected.delegate_class === "juror" ? "jury" : "task"}. This job uses one event trigger with “any” matching.</small></> : triggerKind === "cron" ? <><label htmlFor="automation-cron-expression">Cron expression</label>
                    <input id="automation-cron-expression" value={cronExpr} maxLength={100} required onChange={event => setCronExpr(event.target.value)} placeholder="0 9 * * *" />
                    <label htmlFor="automation-cron-timezone">IANA timezone</label><input id="automation-cron-timezone" value={timezone} maxLength={80} required onChange={event => setTimezone(event.target.value)} placeholder="UTC" />
                    <small>Missed scheduled runs replay oldest first when the service returns.</small></> : <><label htmlFor="automation-interval-ms">Repeat every (milliseconds)</label>
                    <input id="automation-interval-ms" type="number" min={60000} max={2147483647} step={60000} value={intervalMs} onChange={event => setIntervalMs(Number(event.target.value))} />
                    <small>Interval schedules coalesce missed slots and resume at the current interval.</small></>}
                <label htmlFor="automation-create-config">{durableWork ? "Work run and approved turn settings (JSON object)" : "Action parameters and policy (JSON object)"}</label>
                <textarea id="automation-create-config" value={actionConfigText} maxLength={12000} rows={7} onChange={event => setActionConfigText(event.target.value)} spellCheck={false} />
                {durableWork ? <>
                    <label htmlFor="automation-work-run-id">Encrypted work run ID</label>
                    <input id="automation-work-run-id" value={workRunId} onChange={event => setWorkRunId(event.target.value)} required placeholder="Run UUID" />
                    <label htmlFor="automation-work-model">MySo model</label>
                    <select id="automation-work-model" value={workModelId} onChange={event => setWorkModelId(event.target.value)} required>
                        <option value="">Choose a tool-capable model</option>
                        {models.filter(model => model.supports_tools && model.max_output_tokens).map(model => <option key={model.id} value={model.id}>{model.display_name} · {model.id}</option>)}
                    </select>
                    <label htmlFor="automation-work-turns">Maximum model turns</label>
                    <input id="automation-work-turns" type="number" min={1} max={100} value={workMaxTurns} onChange={event => setWorkMaxTurns(Number(event.target.value))} />
                    <label htmlFor="automation-work-tokens">Maximum output tokens per turn</label>
                    <input id="automation-work-tokens" type="number" min={1} max={models.find(model => model.id === workModelId)?.max_output_tokens ?? 32768} value={workMaxTokens} onChange={event => setWorkMaxTokens(Number(event.target.value))} />
                    <label className="myso-automation-create-confirm"><input type="checkbox" checked={allowRoomHistory} onChange={event => setAllowRoomHistory(event.target.checked)} /> Allow this unattended run to read authorized room messages and selected verified attachments.</label>
                    <label className="myso-automation-create-confirm"><input type="checkbox" checked={allowPrivateGraph} onChange={event => setAllowPrivateGraph(event.target.checked)} /> Allow each execution of this automation to use purchased private graphs.</label>
                    <label className="myso-automation-create-confirm"><input type="checkbox" checked={allowPrivateTaskArtifacts} onChange={event => setAllowPrivateTaskArtifacts(event.target.checked)} /> Allow this run to read deliverables from the run’s linked task.</label>
                    {(allowRoomHistory || allowPrivateGraph || allowPrivateTaskArtifacts) && <label className="myso-automation-create-confirm"><input type="checkbox" checked={allowPrivateContentSharing} onChange={event => setAllowPrivateContentSharing(event.target.checked)} /> Allow authorized private context to be sent to other services used by this run.</label>}
                    {allowPrivateGraph&&<small>This is standing owner consent for this automation’s executions. Each triggered run receives a separate short-lived worker credential; graph content may be decrypted through that worker’s MyData session and sent to the selected hosted model for that run. Per-read access checks remain active, and provider retention follows its own policy.</small>}
                    <small>Private context remains scoped to the selected source consent. Task-artifact access is limited to this run’s linked task and assigned participant. The worker uses the encrypted run plan as its prompt; selected action allowlists and live on-chain spend caps remain authoritative.</small>
                </> : <>
                    <label htmlFor="automation-create-config">Action parameters and policy (JSON object)</label>
                    <textarea id="automation-create-config" value={actionConfigText} maxLength={12000} rows={7} onChange={event => setActionConfigText(event.target.value)} spellCheck={false} />
                    <small>The selected action ID is set by the server. Configure `params` and optional `policy` from that action’s documented payload; chain capability and spend policy remain authoritative.</small>
                </>}
                <div className="myso-verified-receipt"><strong>Live authorization</strong><span>Every action is checked against current on-chain permissions and limits when it executes. This automation adds no separate spending cap.</span></div>
                <label className="myso-automation-create-confirm"><input type="checkbox" checked={confirmEnabled} onChange={event => setConfirmEnabled(event.target.checked)} /> I understand this job starts enabled and may execute the selected action automatically on its event or schedule.</label>
            </>}
            {error && <p className="myso-error" role="alert">{error}</p>}
            {validation?.signature === signature && <div className="myso-verified-receipt"><strong>Preflight passed · {validation.result.action_kind}</strong><span>{validation.result.trigger_count} trigger checked</span><span>Creation starts this job enabled: {validation.result.enabled_on_create ? "yes" : "no"}</span><small>{validation.result.notice}</small></div>}
            {notice && <p role="status">{notice}</p>}
            <div className="myso-toolbar"><button type="button" className="myso-secondary" disabled={submitting || !selected || !actionId} onClick={()=>void validate()}>{submitting ? "Checking…" : "Validate setup"}</button><button type="submit" className="myso-primary" disabled={submitting || !selected || !actionId || !confirmEnabled || validation?.signature !== signature}>{submitting ? "Working…" : "Create enabled automation"}</button></div>
        </form>
    </section>;
}
