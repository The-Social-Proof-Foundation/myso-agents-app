"use client";

import { useEffect, useRef, useState } from "react";

const SUCCESS_HOLD_MS = 1400;
const STEP_MS = 2000;
const SIGN_IN_STEPS = [
    "Signing in...",
    "Generating zero-knowledge proof...",
    "Verifying proof...",
    "Securing your session...",
] as const;

export function LoginStatusOverlay({ phase }: { phase: "processing" | "success" }) {
    const [step, setStep] = useState(0);
    useEffect(() => {
        if (phase !== "processing") {
            setStep(0);
            return;
        }
        const timer = window.setInterval(() => {
            setStep((current) => Math.min(current + 1, SIGN_IN_STEPS.length - 1));
        }, STEP_MS);
        return () => window.clearInterval(timer);
    }, [phase]);
    const processingText = SIGN_IN_STEPS[step] ?? SIGN_IN_STEPS[0];
    const label = phase === "success" ? "Signed in" : processingText;
    return (
        <div className="myso-login-overlay" role="status" aria-live="polite" aria-label={label}>
            {phase === "success" ? (
                <div className="myso-login-success">
                    <SuccessCheck />
                    <p>Signed in</p>
                </div>
            ) : (
                <div className="myso-login-processing">
                    <LoadingSpinner />
                    <p><TextSwap text={processingText} /></p>
                </div>
            )}
        </div>
    );
}

export const LOGIN_SUCCESS_HOLD_MS = SUCCESS_HOLD_MS;

function LoadingSpinner() {
    const radius = 9;
    const circumference = 2 * Math.PI * radius;
    const arc = 0.35 * circumference;
    return (
        <svg className="myso-login-spinner" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r={radius} stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" opacity={0.2} />
            <g transform="translate(12 12)">
                <g className="myso-login-spinner-arc">
                    <circle cx="0" cy="0" r={radius} stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={`${arc} ${circumference - arc}`} />
                </g>
            </g>
        </svg>
    );
}

function SuccessCheck() {
    const ref = useRef<HTMLSpanElement>(null);
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            el.setAttribute("data-state", "in");
            return;
        }
        const frame = window.requestAnimationFrame(() => el.setAttribute("data-state", "in"));
        return () => window.cancelAnimationFrame(frame);
    }, []);
    return (
        <span ref={ref} className="t-success-check" data-state="out" aria-hidden="true" style={{ ["--check-path-length" as string]: "28" }}>
            <svg width="88" height="88" viewBox="0 0 48 48" fill="none">
                <circle cx="24" cy="24" r="22" fill="var(--highlight)" />
                <path d="M15 24.5L21.5 31L33 18" stroke="var(--background)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
        </span>
    );
}

function TextSwap({ text }: { text: string }) {
    const ref = useRef<HTMLSpanElement>(null);
    const [displayText, setDisplayText] = useState(text);
    const previous = useRef(text);
    useEffect(() => {
        if (text === previous.current) return;
        const el = ref.current;
        if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            setDisplayText(text);
            previous.current = text;
            return;
        }
        el.classList.add("is-exit");
        const timer = window.setTimeout(() => {
            setDisplayText(text);
            el.classList.remove("is-exit");
            el.classList.add("is-enter-start");
            void el.offsetHeight;
            el.classList.remove("is-enter-start");
            previous.current = text;
        }, 280);
        return () => window.clearTimeout(timer);
    }, [text]);
    return <span ref={ref} className="t-text-swap">{displayText}</span>;
}
