"use client";

import { useState } from "react";
import { Moon, Sun } from "lucide-react";

// The `dark` class is only ever set by this toggle; nothing applies it at boot
// (see globals.css, which uses a prefers-color-scheme media query instead). So
// "light" is the correct initial state and no mount-time read of the DOM is
// needed.
export function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  function toggleTheme() {
    const newTheme = theme === "light" ? "dark" : "light";
    setTheme(newTheme);
    if (newTheme === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }

  return (
    <button
      onClick={toggleTheme}
      className="fixed top-4 right-4 z-50 rounded-full bg-white/80 p-2 text-zinc-800 shadow-lg backdrop-blur-md transition hover:bg-white dark:bg-zinc-800/80 dark:text-zinc-200 dark:hover:bg-zinc-800"
      aria-label="Toggle theme"
    >
      {theme === "light" ? <Moon size={20} /> : <Sun size={20} />}
    </button>
  );
}
