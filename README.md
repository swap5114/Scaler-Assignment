# Jira Data Scraping and LLM Training Pipeline

This project implements a robust data scraping and transformation pipeline that extracts public issue data from Apache's Jira instance and converts it into a structured JSONL corpus suitable for training Large Language Models (LLMs). The system is designed to be efficient, fault-tolerant, and scalable, handling real-world challenges like network issues, rate limiting, and data inconsistencies.

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Architecture](#architecture)
- [Data Scraping](#data-scraping)
- [Data Transformation](#data-transformation)
- [Optimization and Reliability](#optimization-and-reliability)
- [Edge Cases Handled](#edge-cases-handled)
- [Output Format](#output-format)
- [Future Improvements](#future-improvements)
- [License](#license)

## Features

- **Comprehensive Scraping**: Fetches issues, comments, and metadata from Apache Jira projects
- **Fault-Tolerant**: Handles network failures, rate limits, and data inconsistencies
- **Resumable**: Checkpoint system allows resuming interrupted scrapes
- **Memory Efficient**: Uses streaming and batching to handle large datasets
- **LLM-Ready Output**: Transforms data into instruction-response pairs for model training
- **Configurable**: Easy to modify projects, batch sizes, and other parameters

## Requirements

- Node.js (v14 or higher)
- npm or yarn
- Internet connection for API access

## Installation

1. Clone this repository:
   ```bash
   git clone <repository-url>
   cd jira-pipeline
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. (Optional) Set up a virtual environment if needed, though Node.js doesn't require one.

## Configuration

The pipeline is configured via constants at the top of `pipeline.js`:

- `BASE_URL`: Apache Jira API endpoint
- `PROJECTS`: Array of project keys to scrape (default: ["HADOOP", "SPARK", "KAFKA"])
- `PAGE_SIZE`: Number of issues to fetch per API call (default: 1000)
- `OUTPUT_DIR`: Directory for raw data storage (default: "./data")
- `CHECKPOINT_FILE`: File to store progress (default: "./checkpoint.json")
- `FINAL_OUTPUT`: Output file for transformed data (default: "./llm_corpus.jsonl")
- `MAX_FIELD_LENGTH`: Maximum size for issue data to prevent memory issues (default: 50000)

## Usage

Run the pipeline:

```bash
node pipeline.js
```

The script will:
1. Scrape issues from each configured project
2. Save raw data to JSONL files in the `./data` directory
3. Transform the data into LLM training format
4. Output the final corpus to `llm_corpus.jsonl`

### Resuming Interrupted Runs

The pipeline automatically saves progress to `checkpoint.json`. If interrupted, simply run the script again to resume from the last successful point.

### Monitoring Progress

The script provides console output showing:
- Current project being scraped
- Number of issues fetched
- Progress through pagination
- Transformation status

## Architecture

The pipeline consists of three main components:

1. **Scraper Module** (`scrapeProject` function):
   - Handles API requests with pagination
   - Implements retry logic and error handling
   - Manages checkpoints for resumability

2. **Data Cleaner** (`cleanText` function):
   - Normalizes text fields
   - Removes newlines and trims whitespace
   - Limits text length to prevent memory issues

3. **Transformer Module** (`transformAll` and `makeTrainingData` functions):
   - Processes raw JSONL data using streaming
   - Generates multiple training examples per issue
   - Batches output for memory efficiency

## Data Scraping

### API Integration

The scraper uses Apache's public Jira REST API (v2) to fetch issues. It constructs JQL queries like:
```
project=HADOOP ORDER BY created ASC
```

### Pagination Handling

- Fetches issues in batches of 1000 (configurable)
- Tracks `startAt` and `total` to manage pagination
- Continues until all issues are retrieved

### Rate Limiting and Error Handling

- Implements exponential backoff for rate limits (HTTP 429)
- Retries up to 5 times for server errors (5xx)
- Uses timeouts to prevent hanging requests
- Skips overly large issues to avoid memory problems

### Checkpoint System

- Saves progress after each successful batch
- Stores `startAt`, `total`, and timestamp per project
- Allows seamless resumption of interrupted runs

## Data Transformation

### Input Processing

- Reads raw JSONL files using Node.js streams
- Parses each line as a JSON issue object
- Extracts relevant fields: summary, description, comments, issue type

### Text Cleaning

- Replaces newlines with spaces
- Trims whitespace
- Limits text to 10,000 characters to prevent memory issues

### Training Data Generation

For each issue, creates three training examples:

1. **Summarization**: "Summarize the following Jira issue."
2. **Classification**: "Classify the issue type (Bug, Improvement, Task, Other)."
3. **Problem Identification**: "What is the main problem described in this issue?"

Each example includes:
- `instruction`: The task description
- `input`: Concatenated title, description, and comments
- `response`: Expected output based on issue data

## Optimization and Reliability

### Memory Management

- Uses streaming I/O to process large files without loading into memory
- Batches training examples (50 at a time) before writing to disk
- Limits individual issue size to prevent memory spikes

### Performance Optimizations

- Fetches large batches (1000 issues) to minimize API calls
- Adds small delays (500ms) between requests to be respectful
- Processes files sequentially to avoid overwhelming the system

### Fault Tolerance

- Comprehensive error handling for network issues
- Checkpoint system for resumability
- Graceful degradation (skips problematic issues)
- Retry mechanisms with backoff

## Edge Cases Handled

- **Network Issues**: Timeouts, connection failures, DNS problems
- **API Limits**: Rate limiting (429), server errors (5xx)
- **Data Quality**: Missing fields, malformed JSON, empty responses
- **Large Data**: Oversized issues, memory constraints
- **Interruptions**: Process kills, system restarts
- **Empty Results**: Projects with no issues, incomplete pages

## Output Format

The final output is a JSONL file where each line is a JSON object:

```json
{
  "instruction": "Summarize the following Jira issue.",
  "input": "Title: Issue Title\nDescription: Issue description...\nComments: Comment 1 | Comment 2",
  "response": "Brief summary of the issue."
}
```

This format is directly compatible with many LLM training frameworks.

## Future Improvements

- **Parallel Processing**: Scrape multiple projects concurrently
- **Advanced Filtering**: Support for date ranges, issue types, custom JQL
- **Data Enrichment**: Fetch additional fields like attachments, linked issues
- **Quality Metrics**: Implement data validation and cleaning heuristics
- **Cloud Deployment**: Containerize for scalable execution
- **Monitoring**: Add logging and metrics collection
- **Configuration Management**: Move settings to external config files
- **Testing Suite**: Comprehensive unit and integration tests

## License

This project is open source. Please check the license file for details.
