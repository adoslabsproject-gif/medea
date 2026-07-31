import { createContext, useContext, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark' | 'hc';

/** Chiave localStorage della preferenza tema. */
export const THEME_KEY = 'medea.theme';

interface ThemeContextValue {
  theme: ThemeMode;
  setTheme: (m: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}

interface Props {
  value: ThemeMode;
  onChange: (m: ThemeMode) => void;
  children: ReactNode;
}

export function ThemeProvider({ value, onChange, children }: Props) {
  useEffect(() => {
    const root = document.documentElement;
    if (value === 'system') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', value);
    }
  }, [value]);

  const ctx = useMemo<ThemeContextValue>(() => ({ theme: value, setTheme: onChange }), [value, onChange]);

  return <ThemeContext.Provider value={ctx}>{children}</ThemeContext.Provider>;
}
