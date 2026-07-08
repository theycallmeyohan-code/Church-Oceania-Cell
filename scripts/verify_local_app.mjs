import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import Module from "node:module";

const userProfile = process.env.USERPROFILE || process.env.HOME;
const bundledNodeModules = path.join(
  userProfile,
  ".cache",
  "codex-runtimes",
  "codex-primary-runtime",
  "dependencies",
  "node",
  "node_modules"
);
const bundledPnpm = path.join(bundledNodeModules, ".pnpm", "playwright-core@1.61.1", "node_modules");
process.env.NODE_PATH = [bundledNodeModules, bundledPnpm, process.env.NODE_PATH || ""].filter(Boolean).join(path.delimiter);
Module._initPaths();

const require = createRequire(path.join(bundledNodeModules, "playwright", "package.json"));
const { chromium } = require("playwright");

const baseUrl = process.argv[2] || "http://127.0.0.1:4173/";
const outDir = path.resolve("scratch/oceania-private/verification");
await mkdir(outDir, { recursive: true });

const executablePath = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
].find((candidate) => existsSync(candidate));
const browser = await chromium.launch({
  headless: true,
  executablePath
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
const warnings = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() !== "error") return;
  const text = message.text();
  if (text.includes("Failed to load resource") && text.includes("404")) {
    warnings.push(text);
    return;
  }
  errors.push(text);
});

await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".member-card", { timeout: 10000 });

const mainState = await page.evaluate(() => {
  const cells = [...document.querySelectorAll(".cell-tab")].map((button) => button.innerText.trim());
  const cards = [...document.querySelectorAll(".member-card")];
  const brokenImages = [...document.images]
    .filter((image) => !image.complete || image.naturalWidth === 0)
    .map((image) => image.alt || image.src);
  const members = Array.isArray(window.PRIVATE_INITIAL_MEMBERS) ? window.PRIVATE_INITIAL_MEMBERS : [];
  const visits = Array.isArray(window.INITIAL_VISITS) ? window.INITIAL_VISITS : [];
  const currentCellId = members[0]?.cellId || "";
  const target = members.find((member) =>
    member.cellId === currentCellId &&
    (member.phone || member.address || member.birth) &&
    (member.prayerRequests || visits.some((visit) => visit.memberId === member.id))
  ) || members.find((member) => member.cellId === currentCellId);
  return {
    title: document.querySelector("#communityTitleText")?.textContent || "",
    cells,
    visibleCards: cards.length,
    totalMembers: members.length,
    totalVisits: visits.length,
    membersWithPrayer: members.filter((member) => member.prayerRequests).length,
    brokenImages,
    targetId: target?.id || ""
  };
});

if (mainState.targetId) {
  await page.click(`[data-member-id="${mainState.targetId}"]`);
  await page.waitForSelector("#memberForm:not(.hidden)", { timeout: 10000 });
}

const detailState = await page.evaluate(() => ({
  selected: Boolean(document.querySelector("#memberForm:not(.hidden)")),
  hasName: Boolean(document.querySelector("#memberName")?.value),
  hasProfileData: [
    "#memberPhone",
    "#memberHomePhone",
    "#memberBirth",
    "#memberAddress",
    "#memberMemo",
    "#memberPrayer"
  ].some((selector) => Boolean(document.querySelector(selector)?.value)),
  visitCountLabel: document.querySelector("#visitCount")?.textContent || ""
}));

await page.screenshot({ path: path.join(outDir, "main.png"), fullPage: true });

await page.goto(new URL("annual-report.html", baseUrl).href, { waitUntil: "networkidle" });
await page.waitForSelector(".annual-page", { timeout: 10000 });
const annualState = await page.evaluate(() => {
  const pages = [...document.querySelectorAll(".annual-page")];
  const brokenImages = [...document.images]
    .filter((image) => !image.complete || image.naturalWidth === 0)
    .map((image) => image.alt || image.src);
  return {
    status: document.querySelector("#annualStatus")?.textContent || "",
    pageCount: pages.length,
    brokenImages
  };
});
await page.screenshot({ path: path.join(outDir, "annual-report.png"), fullPage: true });

await browser.close();

const result = {
  mainState,
  detailState,
  annualState,
  errors,
  warnings,
  screenshots: {
    main: path.join(outDir, "main.png"),
    annual: path.join(outDir, "annual-report.png")
  }
};

console.log(JSON.stringify(result, null, 2));

if (errors.length || mainState.brokenImages.length || annualState.brokenImages.length || !detailState.selected) {
  process.exitCode = 1;
}
