"use client";

import { useEffect, useState } from "react";
import { Toaster } from "sileo";

function useThemeFromRootAttribute() {
  const [theme, setTheme] = useState("light");

  useEffect(() => {
    const root = document.documentElement;
    const readTheme = () => {
      const attr = root.getAttribute("data-theme");
      setTheme(attr === "dark" ? "dark" : "light");
    };

    readTheme();

    const observer = new MutationObserver(readTheme);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => observer.disconnect();
  }, []);

  return theme;
}

export default function Providers({ children }) {
  const theme = useThemeFromRootAttribute();

  return (
    <>
      {children}
      <Toaster
        position="top-center"
        theme={theme}
        options={{
          duration: 4200,
          roundness: 14,
          styles: {
            title: "sileo-title-lg",
            description: "sileo-desc-lg",
            button: "sileo-btn-lg",
          },
        }}
      />
    </>
  );
}
