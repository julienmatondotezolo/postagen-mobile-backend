import { Router, Request, Response } from "express";
import OpenAI from "openai";
import { parse as parseHTML } from "node-html-parser";

export const brandRouter = Router();

interface AnalyzeBrandRequest {
  url: string;
}

interface AnalyzeBrandResponse {
  businessName: string;
  description: string;
  tone: string;
  menuHighlights: string[];
}

/**
 * Fetch a URL and extract readable text from the HTML.
 * Strips scripts, styles, nav, footer and returns clean text.
 */
async function scrapeWebsite(url: string): Promise<string> {
  // Ensure URL has protocol
  let normalizedUrl = url.trim();
  if (!normalizedUrl.startsWith("http://") && !normalizedUrl.startsWith("https://")) {
    normalizedUrl = "https://" + normalizedUrl;
  }

  console.log(`🌐 Fetching: ${normalizedUrl}`);

  const response = await fetch(normalizedUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9,nl;q=0.8",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${normalizedUrl}: HTTP ${response.status}`);
  }

  const html = await response.text();
  console.log(`📄 Fetched ${html.length} chars of HTML`);

  // Parse HTML and extract text
  const root = parseHTML(html);

  // Remove non-content elements
  const removeTags = ["script", "style", "nav", "footer", "noscript", "svg", "iframe"];
  for (const tag of removeTags) {
    root.querySelectorAll(tag).forEach((el) => el.remove());
  }

  // Get text content
  let text = root.text;

  // Clean up whitespace
  text = text
    .replace(/\s+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();

  // Truncate to ~8000 chars to fit GPT context
  if (text.length > 8000) {
    text = text.substring(0, 8000) + "...";
  }

  console.log(`📝 Extracted ${text.length} chars of text content`);
  return text;
}

// POST /api/brand/analyze
brandRouter.post("/analyze", async (req: Request, res: Response) => {
  try {
    const { url } = req.body as AnalyzeBrandRequest;

    if (!url || url.trim().length === 0) {
      res.status(400).json({
        error: "URL is required",
        message: "Please provide a website URL to analyze.",
      });
      return;
    }

    // Check OpenAI key
    if (!process.env.OPENAI_API_KEY) {
      res.status(500).json({
        error: "OpenAI API key not configured",
        message: "Set OPENAI_API_KEY in the .env file.",
      });
      return;
    }

    // Step 1: Scrape the website
    let websiteText: string;
    try {
      websiteText = await scrapeWebsite(url);
    } catch (scrapeError) {
      console.error("❌ Scrape error:", scrapeError);
      res.status(422).json({
        error: "Could not fetch website",
        message:
          "We couldn't access the website. Please check the URL and try again, or describe your brand manually.",
      });
      return;
    }

    if (websiteText.length < 50) {
      res.status(422).json({
        error: "Insufficient content",
        message:
          "The website didn't contain enough text to analyze. Please describe your brand manually.",
      });
      return;
    }

    // Step 2: Send to GPT-4o for analysis
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are a brand analyst. Analyze the website content below and extract key business information.
Return ONLY valid JSON in this exact format (no markdown, no code blocks):
{
  "businessName": "The official business name",
  "description": "A comprehensive 2-3 sentence description of the business, its values, and what makes it unique. Write in the language of the website.",
  "tone": "Describe the brand's communication tone in 3-5 comma-separated adjectives",
  "menuHighlights": ["Key product 1", "Key product 2", "Key service 1"]
}

Rules:
- businessName: the actual name of the business (not the domain)
- description: write in the same language as the website content. Be specific, not generic.
- tone: e.g. "warm, professional, playful, luxurious"
- menuHighlights: list 5-10 key products, services, or offerings. If it's a restaurant, list menu items. If it's a shop, list product categories. Leave empty array if unclear.
- Return ONLY the JSON object, nothing else.`,
        },
        {
          role: "user",
          content: `Analyze this website content from ${url}:\n\n${websiteText}`,
        },
      ],
      max_tokens: 1024,
      temperature: 0.3,
    });

    const rawResponse = completion.choices[0]?.message?.content;
    if (!rawResponse) {
      res.status(500).json({
        error: "Empty AI response",
        message: "The AI could not analyze the website. Please try again or describe your brand manually.",
      });
      return;
    }

    console.log("🤖 Brand analysis response:", rawResponse.substring(0, 500));

    // Parse the JSON response
    let result: AnalyzeBrandResponse;
    try {
      let jsonStr = rawResponse.trim();
      if (jsonStr.startsWith("```")) {
        jsonStr = jsonStr.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
      }
      result = JSON.parse(jsonStr);
    } catch {
      console.error("❌ Failed to parse brand analysis:", rawResponse);
      res.status(500).json({
        error: "Failed to parse AI response",
        message: "The AI returned an invalid format. Please try again or describe your brand manually.",
      });
      return;
    }

    console.log(`✅ Brand analyzed: ${result.businessName}`);

    res.json({
      businessName: result.businessName || "",
      description: result.description || "",
      tone: result.tone || "",
      menuHighlights: result.menuHighlights || [],
    });
  } catch (error: unknown) {
    console.error("❌ Error in /api/brand/analyze:", error);

    if (error instanceof OpenAI.APIError) {
      res.status(error.status || 500).json({
        error: "OpenAI API error",
        message: error.message,
      });
      return;
    }

    res.status(500).json({
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
});
