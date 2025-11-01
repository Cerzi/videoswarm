import React from "react";
import { supportContent } from "../config/supportContent";

export default function SupportLink({ children, className = "", ...props }) {
  return (
    <a
      href={supportContent.donationUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      {...props}
    >
      {children ?? supportContent.donationLinkLabel}
    </a>
  );
}
