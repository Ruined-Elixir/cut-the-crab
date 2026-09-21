import { useEffect, useState } from "react";

import ctcLogo from "../../assets/CTC_app_icon.png";
import ctcLogoWhite from "../../assets/CTC_app_icon_white.png";

type CtcLogoProps = {
  className?: string;
  alt?: string;
  decorative?: boolean;
};

function getPrefersDarkMode() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function CtcLogo({
  className,
  alt = "Cut The Crab",
  decorative = false,
}: CtcLogoProps) {
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
      src={isDarkMode ? ctcLogoWhite : ctcLogo}
      alt={decorative ? "" : alt}
      aria-hidden={decorative ? true : undefined}
      draggable={false}
    />
  );
}

export default CtcLogo;
