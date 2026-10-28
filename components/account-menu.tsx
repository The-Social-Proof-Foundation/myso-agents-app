"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { HoldSignOutButton } from "./hold-sign-out-button";

const GRAPHQL_URL = process.env.NEXT_PUBLIC_GRAPHQL_URL || "https://graphql.testnet.mysocial.network/graphql";
const PROFILE_QUERY = `query ProfileMenu($address: MySoAddress!) {
  profile(address: $address) {
    address
    username
    displayName
    profilePhoto
    socialProofTokenAddress
    reservationPoolAddress
    socialProofToken { reservationPercentage }
  }
}`;

type ProfileMenu = {
    address: string | null;
    username: string | null;
    displayName: string | null;
    profilePhoto: string | null;
    socialProofTokenAddress: string | null;
    reservationPoolAddress: string | null;
    socialProofToken: { reservationPercentage: number | null } | null;
};

function text(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

function ringFor(profile: ProfileMenu | null): { show: boolean; percent: number } {
    const launched = Boolean(profile?.socialProofTokenAddress);
    const reserving = Boolean(profile?.reservationPoolAddress) && !launched;
    if (!launched && !reserving) return { show: false, percent: 0 };
    if (launched) return { show: true, percent: 100 };
    const raw = profile?.socialProofToken?.reservationPercentage;
    const percent = typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
    return { show: true, percent };
}

async function loadProfile(address: string): Promise<ProfileMenu | null> {
    const response = await fetch(GRAPHQL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: PROFILE_QUERY, variables: { address } }),
    });
    if (!response.ok) throw new Error("Profile request failed");
    const body = await response.json() as { data?: { profile?: Record<string, unknown> | null } };
    const node = body.data?.profile;
    if (!node) return null;
    const token = node.socialProofToken;
    const percentage = token && typeof token === "object" && "reservationPercentage" in token
        ? (token as { reservationPercentage?: unknown }).reservationPercentage
        : null;
    return {
        address: text(node.address),
        username: text(node.username),
        displayName: text(node.displayName),
        profilePhoto: text(node.profilePhoto),
        socialProofTokenAddress: text(node.socialProofTokenAddress),
        reservationPoolAddress: text(node.reservationPoolAddress),
        socialProofToken: { reservationPercentage: typeof percentage === "number" ? percentage : null },
    };
}

function shortAddress(address: string): string {
    return address.length > 14 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address;
}

function Avatar({ address, name, photo, showRing, ringPercent, size = 36 }: { address: string; name: string | null; photo: string | null; showRing: boolean; ringPercent: number; size?: number }) {
    const gradientId = useId().replace(/:/g, "");
    const stroke = showRing ? 2.25 : 0;
    const radius = (size - stroke) / 2;
    const circumference = 2 * Math.PI * radius;
    const progress = Math.max(0, Math.min(100, ringPercent));
    const offset = circumference - (progress / 100) * circumference;
    const initial = (name || address.replace(/^0x/i, "")).slice(0, 1).toUpperCase();
    return <span className="myso-avatar" style={{ width: size, height: size }}>
        {showRing && <svg className="myso-avatar-ring" viewBox={`0 0 ${size} ${size}`} aria-hidden>
            <defs>
                <linearGradient id={gradientId} x1="0%" y1="50%" x2="100%" y2="50%">
                    <stop offset="0%" stopColor="#DFFFA8" />
                    <stop offset="100%" stopColor="var(--highlight)" />
                </linearGradient>
            </defs>
            <circle className="myso-avatar-ring-track" cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} />
            {progress > 0 && <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={`url(#${gradientId})`} strokeWidth={stroke} strokeDasharray={circumference} strokeDashoffset={offset} />}
        </svg>}
        {photo ? <img src={photo} alt="" style={{ width: size - 8, height: size - 8 }} /> : <span style={{ width: size - 8, height: size - 8 }}>{initial}</span>}
    </span>;
}

export function AccountMenu({ owner, label, busy, onLogout }: { owner: string | null; label: string; busy: boolean; onLogout: () => void }) {
    const [open, setOpen] = useState(false);
    const [copied, setCopied] = useState(false);
    const [profile, setProfile] = useState<ProfileMenu | null>(null);
    const root = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!owner) { setProfile(null); return; }
        let cancelled = false;
        void loadProfile(owner).then(value => { if (!cancelled) setProfile(value); }).catch(() => { if (!cancelled) setProfile(null); });
        return () => { cancelled = true; };
    }, [owner]);
    useEffect(() => {
        if (!open) return;
        const close = (event: PointerEvent) => {
            if (!root.current?.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener("pointerdown", close);
        return () => document.removeEventListener("pointerdown", close);
    }, [open]);
    const name = profile?.displayName ?? null;
    const username = profile?.username;
    const ring = ringFor(profile);
    return <div className="myso-account-menu" ref={root}>
        <button type="button" className="myso-avatar-button" aria-label="Open account menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>
            <Avatar address={owner || label} name={name} photo={profile?.profilePhoto ?? null} showRing={ring.show} ringPercent={ring.percent} />
        </button>
        {open && <div className="myso-account-panel" role="menu">
            <a className="myso-account-identity" href={owner ? `https://www.mysocial.network/wallet?address=${encodeURIComponent(owner)}` : undefined} target="_blank" rel="noopener noreferrer">
                <Avatar address={owner || label} name={name} photo={profile?.profilePhoto ?? null} showRing={ring.show} ringPercent={ring.percent} size={48} />
                <div>
                    <span className="myso-account-name">{name || (owner ? "Anonymous User" : label)}</span>
                    {username && <span>@{username}</span>}
                    {owner && <small>
                        <button type="button" aria-label="Copy wallet address" onClick={(event) => { event.preventDefault(); event.stopPropagation(); void navigator.clipboard.writeText(owner).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 2000); }); }}>{copied ? <Check size={12} /> : <Copy size={12} />}</button>
                        {shortAddress(owner)}
                    </small>}
                </div>
            </a>
            <HoldSignOutButton disabled={busy} onConfirm={() => { setOpen(false); onLogout(); }} />
        </div>}
    </div>;
}
