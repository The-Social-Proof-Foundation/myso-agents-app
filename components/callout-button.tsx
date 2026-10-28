"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

export interface CalloutButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    /** true = solid corner brackets, false = half strength. */
    borderOpacity?: boolean;
    children?: ReactNode;
}

/** Square frame and corner brackets used by the MySocial Get Started control. */
export const CalloutButton = forwardRef<HTMLButtonElement, CalloutButtonProps>(
    ({ className = "", borderOpacity = true, children, type = "button", ...props }, ref) => {
        const cornerColor = borderOpacity ? "var(--callout-corner)" : "color-mix(in srgb, var(--callout-corner) 50%, transparent)";
        const corner = { borderColor: cornerColor };
        return (
            <button
                ref={ref}
                type={type}
                className={[
                    "relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-none",
                    "border border-[var(--border)] bg-[var(--card)] text-sm font-medium text-[var(--primary)]",
                    "hover:bg-[var(--hover)]",
                    "disabled:pointer-events-none disabled:opacity-50",
                    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
                    className,
                ].filter(Boolean).join(" ")}
                {...props}
            >
                <span className="pointer-events-none absolute top-0 left-0 z-20 h-2 w-2 border-t-2 border-l-2" style={corner} />
                <span className="pointer-events-none absolute top-0 right-0 z-20 h-2 w-2 border-t-2 border-r-2" style={corner} />
                <span className="pointer-events-none absolute bottom-0 left-0 z-20 h-2 w-2 border-b-2 border-l-2" style={corner} />
                <span className="pointer-events-none absolute right-0 bottom-0 z-20 h-2 w-2 border-r-2 border-b-2" style={corner} />
                <span className="relative z-10">{children}</span>
            </button>
        );
    },
);
CalloutButton.displayName = "CalloutButton";
