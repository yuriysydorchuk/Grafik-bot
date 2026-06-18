// One-time helper: obtain a Google OAuth2 refresh token for Drive uploads.
//
// Usage:
//   1. Create an OAuth client (type "Desktop app") in Google Cloud Console.
//   2. Run:  GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... node get-google-token.mjs
//      (or put them in .env and run:  node --env-file=.env get-google-token.mjs )
//   3. Open the printed URL, sign in as the account whose Drive should hold the files, approve.
//   4. Copy the printed GOOGLE_OAUTH_REFRESH_TOKEN into your .env.
import { google } from "googleapis";
import http from "node:http";

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const PORT = 53682;
const REDIRECT = `http://localhost:${PORT}`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET first.");
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT);
const url = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/spreadsheets",
  ],
});

console.log("\n1) Open this URL in your browser and approve access:\n");
console.log(url + "\n");
console.log(`2) Waiting for Google to redirect to ${REDIRECT} ...`);

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT);
  const code = u.searchParams.get("code");
  if (!code) { res.end("No code in request."); return; }
  try {
    const { tokens } = await oauth2.getToken(code);
    res.end("Done. You can close this tab and return to the terminal.");
    console.log("\n✅ Success. Add this line to your .env:\n");
    console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    if (!tokens.refresh_token) {
      console.log("⚠️ No refresh_token returned. Revoke prior access at https://myaccount.google.com/permissions and rerun.");
    }
  } catch (e) {
    res.end("Token exchange failed: " + e.message);
    console.error(e);
  } finally {
    server.close();
    process.exit(0);
  }
});
server.listen(PORT);
