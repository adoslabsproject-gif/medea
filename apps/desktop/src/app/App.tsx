import { useState } from 'react';

import { ThemeProvider } from './providers/ThemeProvider';
import { WelcomeShell } from './WelcomeShell';

export function App() {
  const [theme, setTheme] = useState<'system' | 'light' | 'dark' | 'hc'>('system');
  return (
    <ThemeProvider value={theme} onChange={setTheme}>
      <WelcomeShell />
    </ThemeProvider>
  );
}
