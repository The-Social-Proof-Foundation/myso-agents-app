"use client";

import { useState } from "react";

export function MySoRoomNameEditor({
    groupId,
    currentName,
    available,
    busy,
    onRename,
}: {
    groupId: string;
    currentName: string;
    available: boolean;
    busy: boolean;
    onRename: (name: string) => Promise<void>;
}) {
    const [editing, setEditing] = useState(false);
    const [name, setName] = useState(currentName);
    const [saving, setSaving] = useState(false);

    if (!available) return null;
    if (!editing) {
        return <button type="button" className="myso-text-button" disabled={busy} onClick={() => { setName(currentName); setEditing(true); }}>Rename room</button>;
    }
    return <form className="myso-room-invite" onSubmit={(event) => {
        event.preventDefault();
        if (saving || !name.trim()) return;
        setSaving(true);
        void onRename(name.trim()).then(() => setEditing(false)).finally(() => setSaving(false));
    }}>
        <label htmlFor={`room-name-${groupId}`}>Visible room name</label>
        <input id={`room-name-${groupId}`} value={name} onChange={(event) => setName(event.target.value)} minLength={1} maxLength={128} required disabled={saving} />
        <button type="submit" className="myso-secondary" disabled={saving || busy || !name.trim()}>{saving ? "Updating and verifying…" : "Save room name"}</button>
        <button type="button" className="myso-text-button" disabled={saving} onClick={() => { setName(currentName); setEditing(false); }}>Cancel</button>
    </form>;
}
