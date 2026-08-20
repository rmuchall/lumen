import {invoke} from "@tauri-apps/api/core";

export type Theme = "System" | "Light" | "Dark";

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.remove("appearance-light", "appearance-dark");

  if (theme === "Light") {
    document.documentElement.classList.add("appearance-light");
  } else if (theme === "Dark") {
    document.documentElement.classList.add("appearance-dark");
  }
}

export async function refreshConfiguration(): Promise<string | null> {
  const [theme, configurationError] = await Promise.all([
    invoke<Theme>("configuration_theme"),
    invoke<string | null>("configuration_load_error"),
  ]);
  applyTheme(theme);
  return configurationError;
}
