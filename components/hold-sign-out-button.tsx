"use client";

import { LogOut } from "lucide-react";
import { useRef, useState, type MouseEvent, type TouchEvent, type TransitionEvent } from "react";

/** Press-and-hold sign out, matching the MySocial profile menu. A click does not log out. */
export function HoldSignOutButton({ onConfirm, disabled = false, holdDuration = 650 }: { onConfirm: () => void; disabled?: boolean; holdDuration?: number }) {
    const [holding, setHolding] = useState(false);
    const fired = useRef(false);
    const holdingRef = useRef(false);
    const button = useRef<HTMLButtonElement>(null);

    function start(event: MouseEvent<HTMLButtonElement> | TouchEvent<HTMLButtonElement>) {
        event.stopPropagation();
        if (disabled) return;
        fired.current = false;
        holdingRef.current = true;
        setHolding(true);
    }

    function end(event: MouseEvent<HTMLButtonElement> | TouchEvent<HTMLButtonElement>) {
        event.stopPropagation();
        if (holdingRef.current && !fired.current) {
            holdingRef.current = false;
            setHolding(false);
        }
        button.current?.blur();
    }

    function filled(event: TransitionEvent<HTMLSpanElement>) {
        if (event.propertyName !== "width" || !holdingRef.current || fired.current) return;
        fired.current = true;
        holdingRef.current = false;
        setHolding(false);
        onConfirm();
    }

    return (
        <button
            ref={button}
            type="button"
            role="menuitem"
            className="myso-hold-sign-out"
            disabled={disabled}
            style={holding ? { background: "var(--hover)" } : undefined}
            onMouseDown={start}
            onMouseUp={end}
            onMouseLeave={end}
            onTouchStart={start}
            onTouchEnd={end}
            onTouchCancel={end}
        >
            <span
                aria-hidden
                className="myso-hold-sign-out-fill"
                onTransitionEnd={filled}
                style={{ width: holding ? "100%" : "0%", transitionDuration: holding ? `${holdDuration}ms` : "100ms" }}
            />
            <span className="myso-hold-sign-out-label">
                <LogOut size={16} />
                <span>{holding ? "Keep holding..." : "Sign Out"}</span>
            </span>
        </button>
    );
}
