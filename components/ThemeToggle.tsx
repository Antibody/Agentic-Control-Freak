"use client";

import { useEffect, useState } from "react";
import { SelectMenu, type SelectMenuOption } from "@/components/SelectMenu";

type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "cdl.theme";

function readStoredMode(): ThemeMode {
  if (typeof window === "undefined") {
    return "system";
  }
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === "light" || raw === "dark" || raw === "system") {
    return raw;
  }
  return "system";
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme(mode: ThemeMode): void {
  if (typeof document === "undefined") {
    return;
  }
  const resolved = mode === "system" ? (systemPrefersDark() ? "dark" : "light") : mode;
  document.documentElement.setAttribute("data-theme", resolved);
}

function SunIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="4.2" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 2.6v2.4M12 19v2.4M2.6 12H5M19 12h2.4M5.1 5.1l1.7 1.7M17.2 17.2l1.7 1.7M18.9 5.1l-1.7 1.7M6.8 17.2l-1.7 1.7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function AutoIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8.4" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 3.6a8.4 8.4 0 0 0 0 16.8Z" fill="currentColor" />
    </svg>
  );
}

function MoonIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden>
      <path
        d="M20 14.2A8 8 0 1 1 9.8 4 6.4 6.4 0 0 0 20 14.2Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const THEME_OPTIONS: SelectMenuOption<ThemeMode>[] = [
  { value: "light", label: "Light", description: "Always light", icon: <SunIcon /> },
  { value: "system", label: "Auto", description: "Match the system", icon: <AutoIcon /> },
  { value: "dark", label: "Dark", description: "Always dark", icon: <MoonIcon /> },
];

export function ThemeToggle(): React.ReactElement {
  const [mode, setMode] = useState<ThemeMode>("system");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMode(readStoredMode());
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) {
      return undefined;
    }
    applyTheme(mode);
    window.localStorage.setItem(STORAGE_KEY, mode);
    if (mode !== "system") {
      return undefined;
    }
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (): void => applyTheme("system");
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [mode, mounted]);

  return (
    <SelectMenu
      className="theme-menu"
      ariaLabel="Theme"
      align="end"
      value={mode}
      options={THEME_OPTIONS}
      onSelect={setMode}
    />
  );
}
