"use client";

import type { PhaseDescriptor } from "@/lib/shared/timeline";

interface PhaseRailProps {
  phases: PhaseDescriptor[];
}

function MarkerContent({ status }: { status: PhaseDescriptor["status"] }): React.ReactElement | null {
  switch (status) {
    case "done":
      return (
        <svg viewBox="0 0 14 14" className="marker-icon" aria-hidden>
          <path
            d="M2.5 7.4 L6 10.5 L11.5 4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "error":
      return (
        <svg viewBox="0 0 14 14" className="marker-icon" aria-hidden>
          <path
            d="M7 3 L7 8.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <circle cx="7" cy="10.6" r="1.05" fill="currentColor" />
        </svg>
      );
    case "active":
      return <span className="marker-dot" aria-hidden />;
    default:
      return null;
  }
}

export function PhaseRail({ phases }: PhaseRailProps): React.ReactElement {
  return (
    <ol className="phase-rail" aria-label="Workflow phases">
      {phases.map((phase, index) => {
        const isLast = index === phases.length - 1;
        return (
          <li key={phase.id} className={`phase phase-${phase.status}`}>
            <span className="phase-marker" aria-hidden>
              <MarkerContent status={phase.status} />
            </span>
            <span className="phase-label">{phase.label}</span>
            {!isLast ? <span className="phase-connector" aria-hidden /> : null}
          </li>
        );
      })}
    </ol>
  );
}
