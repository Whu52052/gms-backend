// UI 状态：主题、侧边栏折叠
import { create } from 'zustand';

type ThemeMode = 'light' | 'dark';

interface UIState {
  theme: ThemeMode;
  sidebarCollapsed: boolean;
  toggleTheme: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
}

function initialTheme(): ThemeMode {
  const saved = localStorage.getItem('gms_theme');
  if (saved === 'dark' || saved === 'light') return saved;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export const useUIStore = create<UIState>((set) => ({
  theme: initialTheme(),
  sidebarCollapsed: false,
  toggleTheme: () => set(s => {
    const next: ThemeMode = s.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('gms_theme', next);
    return { theme: next };
  }),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
}));
