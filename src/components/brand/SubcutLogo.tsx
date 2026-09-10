import { useEffect, useState } from "react";

import subcutLogoDarkText from "../../assets/Subcut_transparent-.png";
import subcutLogoLightText from "../../assets/Subcut_transparent-light.png";

type SubcutLogoProps = {
  className?: string;
  alt?: string;
  decorative?: boolean;
};

function getPrefersDarkMode() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function SubcutLogo({
  className,
  alt = "SUBCUT",
  decorative = false,
}: SubcutLogoProps) {
  const [isDarkMode, setIsDarkMode] = useState(getPrefersDarkMode);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

    const handleAppearanceChange = (event: MediaQueryListEvent) => {
      setIsDarkMode(event.matches);
    };

    setIsDarkMode(mediaQuery.matches);
    mediaQuery.addEventListener("change", handleAppearanceChange);

    return () => {
      mediaQuery.removeEventListener("change", handleAppearanceChange);
    };
  }, []);

  return (
    <img
      className={className}
      src={isDarkMode ? subcutLogoLightText : subcutLogoDarkText}
      alt={decorative ? "" : alt}
      aria-hidden={decorative ? true : undefined}
      draggable={false}
    />
  );
}

export default SubcutLogo;
