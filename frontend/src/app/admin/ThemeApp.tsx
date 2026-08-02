"use client";

import { useEffect } from "react";

export default function ThemeApp() {
  useEffect(() => {
    document.documentElement.classList.add("theme-app");
    return () => {
      document.documentElement.classList.remove("theme-app");
    };
  }, []);

  return null;
}
