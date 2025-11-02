// pipeline.js
// This script scrapes Jira issues from Apache projects and converts them into training data for an LLM.
// It handles pagination, rate limiting, and data cleaning to ensure smooth processing.

import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import readline from "readline";

// Configuration settings for the Jira API and data handling
const BASE_URL = "https://issues.apache.org/jira/rest/api/2/search";
const PROJECTS = ["HADOOP", "SPARK", "KAFKA"];
const PAGE_SIZE = 1000; // Fetching a large batch at once to minimize API calls
const OUTPUT_DIR = "./data";
const CHECKPOINT_FILE = "./checkpoint.json";
const FINAL_OUTPUT = "./llm_corpus.jsonl";
const MAX_FIELD_LENGTH = 50000; // Avoiding processing issues with excessively large fields to prevent memory problems

// Pauses execution for a specified number of milliseconds to allow for delays or rate limiting.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Ensures the specified directory exists, creating it and any parent directories if needed.
async function ensureDir(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (e) {
    // It's okay if the directory already exists, no need to worry.
  }
}

// Loads the checkpoint data from a file to resume progress where we left off.
// This is designed for small files only to avoid memory issues.
async function loadCheckpoint() {
  try {
    const data = await fs.readFile(CHECKPOINT_FILE, "utf8");
    return JSON.parse(data);
  } catch {
    return {}; // If no checkpoint exists, start from scratch.
  }
}

// Saves the current progress to a checkpoint file for resumability.
async function saveCheckpoint(checkpoint) {
  await fs.writeFile(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
}

// Performs an HTTP fetch with a timeout to prevent the request from hanging indefinitely.
async function fetchWithTimeout(url, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return response;
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

// Handles the scraping of issues for a single Jira project, including pagination and error handling.
async function scrapeProject(project) {
  console.log(`\nStarting to scrape ${project}...`);

  await ensureDir(OUTPUT_DIR);
  const outFile = path.join(OUTPUT_DIR, `${project}.jsonl`);

  // Create an empty file if it doesn't already exist to prepare for writing.
  if (!fsSync.existsSync(outFile)) {
    await fs.writeFile(outFile, "", "utf8");
  }

  const checkpoint = await loadCheckpoint();
  let startAt = checkpoint[project]?.startAt || 0;
  let total = checkpoint[project]?.total || 999999; // Start with a high number to fetch all issues.
  let retries = 0;

  // Continue fetching pages until all issues are retrieved.
  while (startAt < total) {
    const jql = `project=${project} ORDER BY created ASC`;
    const url = `${BASE_URL}?jql=${encodeURIComponent(jql)}&startAt=${startAt}&maxResults=${PAGE_SIZE}`;

    try {
      console.log(`Fetching ${project} from ${startAt}...`);
      const response = await fetchWithTimeout(url);

      // Handle rate limiting by waiting and retrying.
      if (response.status === 429) {
        console.log("Rate limited! Waiting 10 seconds...");
        await sleep(10000);
        retries++;
        if (retries > 5) {
          console.log("Too many rate limits, skipping this project");
          break;
        }
        continue;
      }

      // Handle server errors by waiting and retrying.
      if (response.status >= 500) {
        console.log(`Server error ${response.status}, waiting 5 seconds...`);
        await sleep(5000);
        retries++;
        if (retries > 5) {
          console.log("Too many server errors, skipping");
          break;
        }
        continue;
      }

      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }

      const data = await response.json();
      const issues = data.issues || [];
      total = data.total || 0;

      console.log(`Got ${issues.length} issues, total is ${total}`);

      if (issues.length === 0) {
        console.log("No more issues, done with this project");
        break;
      }

      // Write each issue to the file, skipping overly large ones to avoid memory issues.
      let written = 0;
      for (const issue of issues) {
        try {
          const issueStr = JSON.stringify(issue);
          // Skip issues that are too large to prevent downstream memory problems.
          if (issueStr.length > MAX_FIELD_LENGTH) {
            console.log(`Skipping huge issue ${issue.key} (${issueStr.length} chars)`);
            continue;
          }
          await fs.appendFile(outFile, issueStr + "\n", "utf8");
          written++;
        } catch (err) {
          console.log(`Error writing issue: ${err.message}`);
        }
      }

      console.log(`Wrote ${written} issues to file`);

      // Update the checkpoint with current progress.
      startAt += issues.length;
      checkpoint[project] = {
        startAt: startAt,
        total: total,
        lastUpdate: new Date().toISOString()
      };
      await saveCheckpoint(checkpoint);

      retries = 0; // Reset retries on successful fetch.

      // Add a short delay to be respectful to the server.
      await sleep(500);

    } catch (error) {
      console.log(`Error: ${error.message}`);
      retries++;
      if (retries > 5) {
        console.log("Too many errors, giving up on this project");
        break;
      }
      await sleep(3000);
    }
  }

  console.log(`Done with ${project}!`);
}

// Cleans and normalizes text fields by removing newlines and trimming whitespace.
// Also caps the length to avoid excessive memory usage in processing.
function cleanText(text) {
  if (!text) return "";
  const cleaned = String(text).replace(/\n/g, " ").trim();
  // Truncate if too long to prevent memory issues.
  return cleaned.length > 10000 ? cleaned.slice(0, 10000) + "..." : cleaned;
}

// Generates multiple training examples from a single Jira issue for LLM training.
function makeTrainingData(issue) {
  try {
    const fields = issue.fields || {};
    const summary = cleanText(fields.summary || "");
    const description = cleanText(fields.description || "");

    // Extract and limit comments to the first 10 for brevity.
    const comments = (fields.comment?.comments || [])
      .slice(0, 10)
      .map((c) => cleanText(c.body || ""))
      .join(" | ");

    const fullText = `Title: ${summary}\nDescription: ${description}\nComments: ${comments}`;

    // Create three distinct training examples from the issue data.
    const examples = [];

    // First example: Teach summarization.
    examples.push({
      instruction: "Summarize the following Jira issue.",
      input: fullText,
      response: description.slice(0, 300) || "No description."
    });

    // Second example: Teach issue type classification.
    examples.push({
      instruction: "Classify the issue type (Bug, Improvement, Task, Other).",
      input: fullText,
      response: fields.issuetype?.name || "Unknown"
    });

    // Third example: Teach problem identification.
    examples.push({
      instruction: "What is the main problem described in this issue?",
      input: description || fullText,
      response: summary || "No summary."
    });

    return examples;
  } catch (err) {
    console.log(`Error creating training data: ${err.message}`);
    return [];
  }
}

// Converts all scraped Jira data into a format suitable for LLM training.
// Uses streaming to process large files without loading everything into memory.
async function transformAll() {
  console.log("\nTransforming data to training format...");

  // Initialize an empty output file for the training corpus.
  fsSync.writeFileSync(FINAL_OUTPUT, "", "utf8");

  const files = fsSync.readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".jsonl"));
  let totalExamples = 0;

  for (const file of files) {
    const filePath = path.join(OUTPUT_DIR, file);
    console.log(`Processing ${file}...`);

    // Use streaming to read the file line by line, avoiding memory overload.
    const fileStream = fsSync.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let batch = [];
    let lineCount = 0;

    for await (const line of rl) {
      lineCount++;
      if (!line.trim()) continue;

      // Skip lines that are excessively long to prevent processing issues.
      if (line.length > MAX_FIELD_LENGTH) {
        console.log(`Skipping huge line ${lineCount} (${line.length} chars)`);
        continue;
      }

      try {
        const issue = JSON.parse(line);
        const examples = makeTrainingData(issue);

        if (examples.length === 0) continue;

        // Accumulate examples in a batch for efficient writing.
        batch.push(...examples);
        totalExamples += examples.length;

        // Flush the batch to disk every 50 examples to manage memory usage.
        if (batch.length >= 50) {
          const batchText = batch.map(ex => JSON.stringify(ex)).join("\n") + "\n";
          fsSync.appendFileSync(FINAL_OUTPUT, batchText, "utf8");
          batch = [];

          if (totalExamples % 500 === 0) {
            console.log(`  ${totalExamples} examples created...`);
          }
        }
      } catch (error) {
        console.log(`Line ${lineCount} error: ${error.message.slice(0, 100)}`);
      }
    }

    // Write any remaining examples in the batch.
    if (batch.length > 0) {
      const batchText = batch.map(ex => JSON.stringify(ex)).join("\n") + "\n";
      fsSync.appendFileSync(FINAL_OUTPUT, batchText, "utf8");
    }

    console.log(`  Finished ${file} - ${totalExamples} total examples`);
  }

  console.log(`\nDone! Created ${totalExamples} training examples in ${FINAL_OUTPUT}`);
}

// Entry point for the script execution.
// Orchestrates the scraping of projects and transformation into training data.
(async () => {
  console.log("=== Starting Jira Pipeline ===");
  console.log(new Date().toISOString());

  await ensureDir(OUTPUT_DIR);

  // Process each project sequentially to gather all issues.
  for (const project of PROJECTS) {
    await scrapeProject(project);
  }

  // Convert the collected data into LLM training examples.
  await transformAll();

  console.log("\n=== All Done! ===");
  console.log(new Date().toISOString());
})();
