import React from "react";
import { supportContent } from "../config/supportContent";

export default function HelpMenu({ onOpenAbout }) {
  return (
    <select
      className="select-control help-menu"
      title="Help and about"
      onChange={(event) => {
        const { value } = event.target;
        if (value === "about") {
          onOpenAbout?.();
        }
        if (value === "donate") {
          if (typeof window !== "undefined") {
            window.open(
              supportContent.donationUrl,
              "_blank",
              "noopener,noreferrer"
            );
          }
        }
        event.target.value = "placeholder";
      }}
      defaultValue="placeholder"
    >
      <option value="placeholder" disabled>
        Help
      </option>
      <option value="about">About VideoSwarm</option>
      <option value="donate">{supportContent.donationLinkLabel}</option>
    </select>
  );
}
