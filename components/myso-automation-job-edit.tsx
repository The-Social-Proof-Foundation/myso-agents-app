"use client";

import { useState, type FormEvent } from "react";
import type { AutomationJobValidation } from "./myso-automation-job-create";

export interface AutomationJobConfiguration {
    trigger_set: Record<string, unknown>;
    action: { kind: "memory_relayer_call" | "registered_action" | "webhook" | "work_run"; config: Record<string, unknown> };
}

export function MySoAutomationJobEdit({ jobName, triggerSet, action, onValidate, onSave, onCancel }: {
    jobName: string;
    triggerSet: Record<string, unknown>;
    action: AutomationJobConfiguration["action"];
    onValidate: (configuration: AutomationJobConfiguration) => Promise<AutomationJobValidation>;
    onSave: (configuration: AutomationJobConfiguration) => Promise<void>;
    onCancel: () => void;
}) {
    const [triggerText, setTriggerText] = useState(JSON.stringify(triggerSet, null, 2));
    const [actionText, setActionText] = useState(JSON.stringify(action, null, 2));
    const [validated, setValidated] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const fingerprint = JSON.stringify([triggerText, actionText]);

    function readInput(): AutomationJobConfiguration | null {
        try {
            const trigger = JSON.parse(triggerText) as unknown;
            const nextAction = JSON.parse(actionText) as unknown;
            if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) throw new Error("Trigger set must be a JSON object.");
            if (!nextAction || typeof nextAction !== "object" || Array.isArray(nextAction)) throw new Error("Action must be a JSON object.");
            const record = nextAction as Record<string, unknown>;
            if (!("memory_relayer_call" === record.kind || "registered_action" === record.kind || "webhook" === record.kind || "work_run" === record.kind) || !record.config || typeof record.config !== "object" || Array.isArray(record.config)) {
                throw new Error("Action must contain a supported kind and a configuration object.");
            }
            return { trigger_set: trigger as Record<string, unknown>, action: { kind: record.kind, config: record.config as Record<string, unknown> } };
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "Enter valid JSON objects for both fields.");
            return null;
        }
    }

    async function validate() {
        setError(""); setNotice("");
        const configuration = readInput(); if (!configuration) return;
        setBusy(true);
        try {
            await onValidate(configuration);
            setValidated(fingerprint);
            setNotice("Preflight passed. No event was dispatched and no action was executed. Save this exact configuration to apply it.");
        } catch (reason) {
            setValidated(null);
            setError(reason instanceof Error ? reason.message : "Preflight failed; the saved job was not changed.");
        } finally { setBusy(false); }
    }

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault(); setError(""); setNotice("");
        const configuration = readInput(); if (!configuration) return;
        if (validated !== fingerprint) { setError("Validate this exact configuration before saving."); return; }
        setBusy(true);
        try { await onSave(configuration); setNotice("Configuration updated. The automation remains paused until you resume it."); }
        catch (reason) { setError(reason instanceof Error ? reason.message : "The configuration was not updated."); }
        finally { setBusy(false); }
    }

    return <section className="myso-settlement-receipt" aria-label={`Edit ${jobName} automation`}>
        <div className="myso-market-sellers-heading"><div><p className="myso-eyebrow">AUTOMATION SETTINGS</p><h3>Edit triggers and action</h3></div></div>
        <p>Only a paused job with no active or uncertain deliveries can be changed. The authenticated target agent, delegate, memory scope, and spend limit stay fixed.</p>
        <p className="myso-room-disclosure">Job reads redact webhook secrets. If this action uses a webhook, enter its secret again in the replacement configuration before validating.</p>
        <form className="myso-automation-create" onSubmit={event => void submit(event)}>
            <label htmlFor="automation-edit-trigger-set">Trigger set JSON</label>
            <textarea id="automation-edit-trigger-set" value={triggerText} maxLength={24000} rows={10} spellCheck={false} onChange={event => { setTriggerText(event.target.value); setValidated(null); }} />
            <label htmlFor="automation-edit-action">Action JSON</label>
            <textarea id="automation-edit-action" value={actionText} maxLength={32000} rows={10} spellCheck={false} onChange={event => { setActionText(event.target.value); setValidated(null); }} />
            {error && <p className="myso-error" role="alert">{error}</p>}
            {notice && <p role="status">{notice}</p>}
            <div className="myso-toolbar"><button type="button" className="myso-secondary" disabled={busy} onClick={() => void validate()}>{busy ? "Checking…" : "Validate configuration"}</button><button type="submit" className="myso-primary" disabled={busy || validated !== fingerprint}>{busy ? "Saving…" : "Save while paused"}</button><button type="button" className="myso-secondary" disabled={busy} onClick={onCancel}>Cancel</button></div>
        </form>
    </section>;
}
