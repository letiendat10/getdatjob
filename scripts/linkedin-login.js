#!/usr/bin/env node
// One-time setup: log into LinkedIn in the dedicated Chrome profile.
// Run: node scripts/linkedin-login.js
// After logging in, press Enter to save the session and close.

const puppeteer = require("puppeteer");
const path = require("path");

const PROFILE_DIR =
  process.env.LINKEDIN_CHROME_PROFILE ||
  path.join(process.env.HOME, ".getdatjob", "chrome-profile");

(async () => {
  console.log(`Opening Chrome with profile: ${PROFILE_DIR}`);
  console.log("Log into LinkedIn, then come back here and press Enter.\n");

  const browser = await puppeteer.launch({
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    userDataDir: PROFILE_DIR,
    headless: false,
    args: ["--start-maximized"],
    defaultViewport: null,
  });

  const page = await browser.newPage();
  await page.goto("https://www.linkedin.com/login");

  await new Promise((resolve) => {
    process.stdout.write("Press Enter once you are logged in... ");
    process.stdin.once("data", resolve);
  });

  await browser.close();
  console.log("\nSession saved to:", PROFILE_DIR);
  console.log("You can now run: node scripts/enrich-daemon.js");
  process.exit(0);
})();
