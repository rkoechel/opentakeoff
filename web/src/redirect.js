// MSAL redirect bridge (msal-browser v5). The sign-in popup and the silent
// renewal iframe land here; this page hands the auth response back to the
// app window over BroadcastChannel and closes. It renders nothing and loads
// none of the app.
import { broadcastResponseToMainFrame } from "@azure/msal-browser/redirect-bridge";

broadcastResponseToMainFrame().catch(() => {
  document.body.textContent = "Sign-in finished. You can close this window.";
});
