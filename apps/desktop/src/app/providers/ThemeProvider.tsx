import { createContext, useContext, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark' | 'hc' | 'carta' | 'grafite' | 'prussia';

/** I temi, con il nome che si legge nelle impostazioni e cosa cambiano. */
export const TEMI: { id: ThemeMode; nome: string; nota: string }[] = [
  { id: 'system', nome: 'Come il sistema', nota: 'Segue chiaro o scuro del computer' },
  { id: 'light', nome: 'Chiaro', nota: 'Il tema chiaro di Medea' },
  { id: 'dark', nome: 'Scuro', nota: 'Il tema scuro di Medea' },
  { id: 'carta', nome: 'Carta', nota: 'Chiaro e caldo, testo in grazie: per chi legge molto' },
  {
    id: 'grafite',
    nome: 'Grafite',
    nota: 'Scuro e neutro, senza dominanti: niente distrae dai dati',
  },
  {
    id: 'prussia',
    nome: 'Prussia',
    nota: 'Scuro e blu, più contrastato: per lavorare con poca luce',
  },
  { id: 'hc', nome: 'Alto contrasto', nota: 'Massima leggibilità' },
];

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

  const ctx = useMemo<ThemeContextValue>(
    () => ({ theme: value, setTheme: onChange }),
    [value, onChange],
  );

  return <ThemeContext.Provider value={ctx}>{children}</ThemeContext.Provider>;
}
