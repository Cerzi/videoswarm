import { supportContent } from "../config/supportContent";

const FALLBACK_DONATION_URL = "https://ko-fi.com/videoswarm";

export async function openDonationPage() {
  const url = supportContent?.donationUrl || FALLBACK_DONATION_URL;
  const hasWindow = typeof window !== "undefined";

  if (hasWindow && window.electronAPI?.openDonationPage) {
    try {
      await window.electronAPI.openDonationPage();
      return true;
    } catch (error) {
      console.warn("electronAPI.openDonationPage failed, falling back to window.open", error);
    }
  }

  if (hasWindow) {
    window.open(url, "_blank", "noopener,noreferrer");
  }

  return false;
}

export default openDonationPage;
