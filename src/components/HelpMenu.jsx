import React from "react";
import { supportContent } from "../config/supportContent";
import { openDonationPage } from "../utils/support";

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
          openDonationPage().catch((error) => {
            console.warn("Failed to open donation page", error);
          });
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
