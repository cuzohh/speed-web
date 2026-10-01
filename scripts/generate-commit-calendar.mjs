#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

function argument(name, fallback = undefined) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] ?? fallback;
}

function usageError(message) {
  throw new Error(`${message}\nUsage: node scripts/generate-commit-calendar.mjs (--repo owner/name | --repo-path path) [--output path] [--days 365]`);
}

function parseDateOnly(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? "");
  if (!match) usageError(`Invalid date: ${value}`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, amount) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + amount);
  return result;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function localCommitDates(repoPath) {
  const output = execFileSync(
    "git",
    ["-C", path.resolve(repoPath), "log", "--all", "--format=%aI"],
    { encoding: "utf8" },
  );
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((value) => value.slice(0, 10));
}

async function remoteCommitDates(repo) {
  const token = process.env.SPEED_REPO_TOKEN;
  if (!token) {
    throw new Error("SPEED_REPO_TOKEN is required when reading a private repository.");
  }

  const dates = [];
  for (let page = 1; ; page += 1) {
    const url = new URL(`https://api.github.com/repos/${repo}/commits`);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));

    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "speed-web-commit-calendar",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub API returned ${response.status}: ${await response.text()}`);
    }

    const commits = await response.json();
    dates.push(
      ...commits
        .map((commit) => commit.commit?.author?.date ?? commit.committer?.date)
        .filter(Boolean)
        .map((value) => value.slice(0, 10)),
    );

    if (commits.length < 100) break;
  }
  return dates;
}

function percentile(sortedValues, percentileValue) {
  if (!sortedValues.length) return 1;
  return sortedValues[Math.floor((sortedValues.length - 1) * percentileValue)];
}

function levelForCount(count, thresholds, maxCount) {
  if (!count) return 0;
  if (maxCount === 1 || count <= thresholds[0]) return 1;
  if (count <= thresholds[1]) return 2;
  if (count <= thresholds[2]) return 3;
  return 4;
}

function buildSvg({ counts, start, end, totalCommits, latestCommit }) {
  const firstSunday = addDays(start, -start.getUTCDay());
  const lastSaturday = addDays(end, 6 - end.getUTCDay());
  const columnCount = Math.floor((lastSaturday - firstSunday) / 86400000 / 7) + 1;
  const cellSize = 12;
  const gap = 3;
  const left = 32;
  const top = 44;
  const right = 16;
  const bottom = 30;
  const width = left + columnCount * (cellSize + gap) - gap + right;
  const height = top + 7 * (cellSize + gap) - gap + bottom;
  const palette = ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"];
  const positiveCounts = [...counts.values()].filter(Boolean).sort((a, b) => a - b);
  const maxCount = positiveCounts.at(-1) ?? 0;
  const thresholds = [
    percentile(positiveCounts, 0.25),
    percentile(positiveCounts, 0.5),
    percentile(positiveCounts, 0.75),
  ];
  const totalLabel = `${totalCommits.toLocaleString()} commit${totalCommits === 1 ? "" : "s"} in the last year`;
  const latestLabel = latestCommit ? `Latest: ${latestCommit}` : "No commits in the selected period";
  const parts = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">`,
    `<title id="title">Private speed repository commit calendar</title>`,
    `<desc id="description">${escapeXml(totalLabel)}. ${escapeXml(latestLabel)}.</desc>`,
    `<style>text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:#57606a;font-size:10px}.stat{font-size:11px;font-weight:600;fill:#24292f}.day{font-size:9px}.background{fill:#ffffff}@media(prefers-color-scheme:dark){text{fill:#8b949e}.stat{fill:#c9d1d9}.background{fill:#0d1117}}</style>`,
    `<rect class="background" x="0" y="0" width="${width}" height="${height}" rx="8"/>`,
    `<text class="stat" x="${left}" y="12">${escapeXml(totalLabel)}</text>`,
    `<text x="${left}" y="23">${escapeXml(latestLabel)}</text>`,
  );

  const seenMonths = new Set();
  for (let column = 0; column < columnCount; column += 1) {
    const columnStart = addDays(firstSunday, column * 7);
    for (let row = 0; row < 7; row += 1) {
      const date = addDays(columnStart, row);
      const key = dateKey(date);
      const inRange = date >= start && date <= end;
      const count = inRange ? counts.get(key) ?? 0 : 0;
      const level = inRange ? levelForCount(count, thresholds, maxCount) : 0;
      const title = `${key}: ${count} commit${count === 1 ? "" : "s"}`;
      const x = left + column * (cellSize + gap);
      const y = top + row * (cellSize + gap);
      parts.push(
        `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="2" fill="${palette[level]}"${inRange ? "" : ' fill-opacity="0"'}><title>${escapeXml(title)}</title></rect>`,
      );

      if (inRange && date.getUTCDate() <= 7) {
        const monthKey = `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
        if (!seenMonths.has(monthKey)) {
          seenMonths.add(monthKey);
          parts.push(
            `<text x="${x}" y="${top - 8}">${date.toLocaleString("en-US", { month: "short", timeZone: "UTC" })}</text>`,
          );
        }
      }
    }
  }

  for (const [label, row] of [["Mon", 1], ["Wed", 3], ["Fri", 5]]) {
    parts.push(`<text class="day" x="0" y="${top + row * (cellSize + gap) + 9}">${label}</text>`);
  }

  const legendY = height - 14;
  parts.push(`<text x="${left}" y="${legendY + 9}">Less</text>`);
  for (let level = 0; level <= 4; level += 1) {
    const x = left + 30 + level * (cellSize + gap);
    parts.push(`<rect x="${x}" y="${legendY}" width="${cellSize}" height="${cellSize}" rx="2" fill="${palette[level]}"/>`);
  }
  parts.push(`<text x="${left + 30 + 5 * (cellSize + gap) + 4}" y="${legendY + 9}">More</text>`, "</svg>");
  return parts.join("\n");
}

const repo = argument("--repo");
const repoPath = argument("--repo-path");
if (!repo && !repoPath) usageError("Provide --repo or --repo-path.");

const output = path.resolve(argument("--output", "assets/speed-commit-calendar.svg"));
const days = Number(argument("--days", "365"));
if (!Number.isInteger(days) || days < 7 || days > 3660) usageError("--days must be an integer between 7 and 3660.");

const end = parseDateOnly(argument("--end", new Date().toISOString().slice(0, 10)));
const start = addDays(end, -(days - 1));
const dates = repoPath ? localCommitDates(repoPath) : await remoteCommitDates(repo);
const counts = new Map();
for (const date of dates) {
  const parsed = parseDateOnly(date);
  if (parsed >= start && parsed <= end) {
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
}

const latestCommit = [...counts.keys()].sort().at(-1);
const svg = buildSvg({
  counts,
  start,
  end,
  totalCommits: [...counts.values()].reduce((sum, count) => sum + count, 0),
  latestCommit,
});
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${svg}\n`);
console.log(`Wrote ${output}`);
