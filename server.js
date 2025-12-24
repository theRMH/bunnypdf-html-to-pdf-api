// server.js
// Main HTTP API server for bunnypdf.
// This file is written to be beginner-friendly but still safe for production use.

import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { chromium } from 'playwright';

// ----- Basic configuration -----

// EasyPanel will usually set PORT in the environment.
// If it is not set (for local development), we fall back to 3000.
const PORT = process.env.PORT || 3000;

// Maximum number of PDF conversions that are allowed to run at the same time.
// Keeping this low protects memory and CPU on a small server (like 4 GB RAM).
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS) || 2;

// Maximum size of the incoming JSON body. This limits how big the HTML can be.
// You can adjust this if you need larger documents, but don't set it too high.
const BODY_SIZE_LIMIT = process.env.BODY_SIZE_LIMIT || '1mb';

// Timeout (in milliseconds) for the PDF rendering steps.
// If Playwright takes longer than this, the request will fail with an error.
const PDF_TIMEOUT_MS = Number(process.env.PDF_TIMEOUT_MS) || 25000; // 25 seconds

// This is the API key we expect from RapidAPI.
// When RAPIDAPI_KEY is set, we will require the header: x-rapidapi-key.
// When it is NOT set (for example in local development), the check is skipped.
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const SHOULD_ENFORCE_API_KEY = Boolean(RAPIDAPI_KEY);

// ----- Express app setup -----

const app = express();

// When running behind a proxy (like on many hosting platforms),
// this helps Express get the real client IP address for rate limiting.
app.set('trust proxy', 1);

// Helmet adds a few small security-related HTTP headers.
// It is a simple way to make the API a bit safer.
app.use(helmet());

// Parse JSON bodies and limit their size to avoid huge HTML payloads.
app.use(express.json({ limit: BODY_SIZE_LIMIT }));

// Basic rate limiting to protect the API from abuse or accidental overload.
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // max 30 requests per IP per minute
  standardHeaders: true, // return rate limit info in the headers
  legacyHeaders: false
});

app.use(limiter);

// ----- Playwright (Chromium) browser management -----

// We keep a single browser instance in memory and reuse it for all requests.
// This is much faster and uses less memory than launching a new browser each time.
let browser = null;

async function getBrowser() {
  if (browser) {
    return browser;
  }

  // Launch Chromium using Playwright.
  // The flags below are commonly used in server environments.
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  });

  return browser;
}

async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

// Gracefully close the browser when the process is stopped.
['SIGINT', 'SIGTERM'].forEach((signal) => {
  process.on(signal, async () => {
    console.log(`Received ${signal}, shutting down...`);
    try {
      await closeBrowser();
    } catch (err) {
      console.error('Error while closing browser:', err);
    } finally {
      process.exit(0);
    }
  });
});

// ----- Simple middleware helpers -----

// Middleware to validate the RapidAPI key header, when configured.
function requireRapidApiKey(req, res, next) {
  if (!SHOULD_ENFORCE_API_KEY) {
    // If no RAPIDAPI_KEY is set, we allow all requests
    // (useful for local development and testing).
    return next();
  }

  const headerKey = req.header('x-rapidapi-key');

  if (!headerKey || headerKey !== RAPIDAPI_KEY) {
    return res.status(401).json({
      error: 'Invalid or missing x-rapidapi-key header'
    });
  }

  return next();
}

// Simple in-memory concurrency limiter.
// It makes sure only a small number of PDF conversions run at the same time.
let activeJobs = 0;

function withPdfQueue(handler) {
  return async (req, res, next) => {
    if (activeJobs >= MAX_CONCURRENT_JOBS) {
      return res.status(429).json({
        error: 'Too many concurrent PDF requests. Please try again shortly.'
      });
    }

    activeJobs += 1;

    try {
      await handler(req, res, next);
    } finally {
      activeJobs -= 1;
    }
  };
}

// ----- Core PDF generation helper -----

/**
 * Convert raw HTML into a PDF buffer using Playwright (Chromium).
 * This function:
 * - creates a new page
 * - sets the page content to the given HTML
 * - uses print mode to generate an A4 PDF
 * - supports background colors/images and @page CSS rules
 * - closes the page to avoid memory leaks
 */
async function generatePdfFromHtml(html) {
  const browserInstance = await getBrowser();
  const page = await browserInstance.newPage();

  try {
    // Intercept all requests made by this page.
    // For now we simply allow everything to continue, but
    // having this hook makes it easy to later block external
    // navigation or certain URLs if you want stricter security.
    await page.route('**/*', (route) => {
      route.continue();
    });

    // Set the HTML content for the page.
    // waitUntil: 'networkidle' waits until network requests are mostly finished,
    // which helps when the HTML loads images, fonts, or CSS from URLs.
    await page.setContent(html, {
      waitUntil: 'networkidle',
      timeout: PDF_TIMEOUT_MS
    });

    // Create the PDF.
    // Important options:
    // - format: 'A4' selects A4 page size
    // - printBackground: true ensures background colors and images are included
    // - margin: small margins so @page CSS and page backgrounds look correct
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '10mm',
        bottom: '10mm',
        left: '10mm',
        right: '10mm'
      },
      timeout: PDF_TIMEOUT_MS
    });

    return pdfBuffer;
  } finally {
    // Always close the page, even if an error happens.
    // This avoids memory leaks and keeps the browser healthy.
    await page.close();
  }
}

// ----- Routes -----

// Simple root route.
// Helpful for basic checks and for platforms that ping "/".
app.get('/', (req, res) => {
  res.json({ name: 'bunnypdf', status: 'running' });
});

// Health check endpoint.
// This is useful for uptime monitoring and load balancers.
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Main endpoint: POST /pdf
// Expects JSON like: { "html": "<html>...</html>" }
// Returns a binary PDF with Content-Type: application/pdf.
app.post(
  '/pdf',
  requireRapidApiKey,
  withPdfQueue(async (req, res) => {
    // Optional: set a hard timeout on the HTTP response.
    // If the PDF takes too long, Node.js will close the connection.
    res.setTimeout(PDF_TIMEOUT_MS + 5000, () => {
      console.error('Response timed out while generating PDF');
      // If the timeout fires, we can still try to send an error
      // (but the client may already be gone).
      if (!res.headersSent) {
        res.status(504).json({ error: 'PDF generation timed out' });
      }
    });

    const { html } = req.body || {};

    // Basic validation of the request body.
    if (typeof html !== 'string' || html.trim().length === 0) {
      return res.status(400).json({
        error: 'Request body must be JSON with a non-empty "html" string field'
      });
    }

    try {
      const pdfBuffer = await generatePdfFromHtml(html);

      // Set headers so the client knows this is a PDF binary.
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', pdfBuffer.length);
      // You may change "inline" to "attachment" if you want forced download.
      res.setHeader('Content-Disposition', 'inline; filename=bunnypdf.pdf');

      // Send the PDF bytes directly in the response.
      return res.send(pdfBuffer);
    } catch (err) {
      console.error('Error generating PDF:', err);

      // If the error is likely a timeout from Playwright, return 504.
      const message = (err && err.message) || '';
      if (message.toLowerCase().includes('timeout')) {
        return res.status(504).json({ error: 'PDF generation timed out' });
      }

      // Generic error for other cases.
      return res.status(500).json({ error: 'Failed to generate PDF' });
    }
  })
);

// ----- Start the server -----

async function start() {
  try {
    // Try to launch the browser once at startup.
    // If it fails here, we exit so you notice the problem early.
    await getBrowser();

    app.listen(PORT, () => {
      console.log(`bunnypdf API listening on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
