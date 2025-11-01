import React from "react";
import { supportContent } from "../config/supportContent";
import { openDonationPage } from "../utils/support";

export default function SupportLink({
  children,
  className = "",
  onClick,
  ...props
}) {
  const handleClick = async (event) => {
    event?.preventDefault?.();
    try {
      await openDonationPage();
    } catch (error) {
      console.warn("Failed to open donation page", error);
    }
    onClick?.(event);
  };

  return (
    <a
      href={supportContent.donationUrl}
      rel="noopener noreferrer"
      className={className}
      onClick={handleClick}
      {...props}
    >
      {children ?? supportContent.donationLinkLabel}
    </a>
  );
}
