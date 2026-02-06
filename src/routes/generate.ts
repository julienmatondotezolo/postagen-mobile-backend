import { Router, Request, Response } from "express";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";
import { buildGeneratePrompt, BrandContext } from "../prompts/generate";

export const generateRouter = Router();

interface MediaItem {
  id: string;
  base64: string; // data URL e.g. "data:image/jpeg;base64,..."
  type: "image" | "video";
  mimeType: string;
}

interface GenerateRequest {
  brandIdentity?: {
    websiteUrl?: string;
    description?: string;
    businessName?: string;
  };
  media: MediaItem[];
}

interface GPTPost {
  mediaIndex: number;
  caption: string;
  hashtags: string[];
  scheduledDate: string;
  scheduledTime: string;
  dayName: string;
  sentiment: "Very Positive" | "Positive" | "Neutral" | "Negative";
}

interface GPTResponse {
  posts: GPTPost[];
  planName: string;
  planDescription: string;
}

// POST /api/generate
generateRouter.post("/", async (req: Request, res: Response) => {
  try {
    const { brandIdentity, media } = req.body as GenerateRequest;

    // Validate input
    if (!media || media.length === 0) {
      res.status(400).json({
        error: "No media provided",
        message: "At least one image is required to generate posts.",
      });
      return;
    }

    // Filter to images only (skip videos for vision API)
    const images = media.filter((m) => m.type === "image");
    if (images.length === 0) {
      res.status(400).json({
        error: "No images provided",
        message: "At least one image is required. Video analysis is not yet supported.",
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

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    // Build brand context
    const brandContext: BrandContext = {
      businessName: brandIdentity?.businessName || "L'Osteria Deerlijk",
      websiteUrl: brandIdentity?.websiteUrl,
      description: brandIdentity?.description,
      tone: "warm, uitnodigend, familiegericht, mix van Nederlands en Italiaans",
      languages: ["nl", "fr", "it"],
    };

    // Today's date for scheduling
    const today = new Date().toISOString().split("T")[0];
    const systemPrompt = buildGeneratePrompt(brandContext, images.length, today);

    // Build messages with images for GPT-4o Vision
    const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      {
        type: "text",
        text: `Hier zijn ${images.length} foto('s) van ${brandContext.businessName}. Analyseer elke foto en genereer een social media post per foto. Antwoord ALLEEN met geldige JSON.`,
      },
    ];

    // Add each image
    for (const img of images) {
      // Ensure the base64 string is a proper data URL
      let imageUrl = img.base64;
      if (!imageUrl.startsWith("data:")) {
        imageUrl = `data:${img.mimeType || "image/jpeg"};base64,${imageUrl}`;
      }

      userContent.push({
        type: "image_url",
        image_url: {
          url: imageUrl,
          detail: "low", // Use low detail to save tokens while still getting good analysis
        },
      });
    }

    console.log(`📸 Sending ${images.length} image(s) to GPT-4o for analysis...`);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      max_tokens: 4096,
      temperature: 0.8,
    });

    const rawResponse = completion.choices[0]?.message?.content;
    if (!rawResponse) {
      res.status(500).json({
        error: "Empty response from OpenAI",
        message: "The AI did not return any content. Please try again.",
      });
      return;
    }

    console.log("🤖 Raw GPT response:", rawResponse);

    // Parse JSON from response (handle potential markdown code blocks)
    let parsed: GPTResponse;
    try {
      // Strip markdown code fences if present
      let jsonStr = rawResponse.trim();
      if (jsonStr.startsWith("```")) {
        jsonStr = jsonStr.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
      }
      parsed = JSON.parse(jsonStr);
    } catch (parseError) {
      console.error("❌ Failed to parse GPT response:", parseError);
      console.error("Raw response was:", rawResponse);
      res.status(500).json({
        error: "Failed to parse AI response",
        message: "The AI returned an invalid format. Please try again.",
        raw: rawResponse,
      });
      return;
    }

    // Helper: compute correct dayName from a date string (never trust GPT for this)
    const DAY_NAMES = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
    const getDayName = (dateStr: string): string => {
      const date = new Date(dateStr + "T12:00:00"); // noon to avoid timezone issues
      return DAY_NAMES[date.getDay()];
    };

    // Helper: generate fallback post for missing media
    const FALLBACK_TIMES = ["12:00 PM", "06:30 PM", "09:00 AM", "03:00 PM", "05:00 PM"];
    const generateFallbackPost = (mediaItem: MediaItem, index: number, startDate: string): typeof posts[0] => {
      const date = new Date(startDate + "T12:00:00");
      // Skip Monday (1) and Sunday (0) for restaurant
      let daysAdded = 0;
      let offset = index;
      while (daysAdded <= offset) {
        date.setDate(date.getDate() + 1);
        const day = date.getDay();
        if (day !== 0 && day !== 1) daysAdded++;
      }
      const dateStr = date.toISOString().split("T")[0];
      return {
        id: `post-${uuidv4()}`,
        mediaId: mediaItem.id,
        caption: `Ontdek de smaken van ${brandContext.businessName || "ons restaurant"}. Elke dag bereiden we onze gerechten met verse ingrediënten en Italiaanse passie. Buon appetito! 🍝`,
        hashtags: ["#LOsteriaDeerlijk", "#LOsteria", "#Deerlijk", "#ItaliaanskeukenDeerlijk", "#FoodiesBelgië"],
        scheduledDate: dateStr,
        scheduledTime: FALLBACK_TIMES[index % FALLBACK_TIMES.length],
        dayName: getDayName(dateStr),
        sentiment: "Very Positive" as const,
        isOptimized: true,
        createdAt: Date.now(),
      };
    };

    // Map GPT response to frontend Post interface
    const posts = parsed.posts.map((gptPost) => {
      // Find the corresponding media item
      const mediaItem = images[gptPost.mediaIndex] || images[0];

      // Compute correct dayName from the date (BUG-1 fix: GPT hallucinates day names)
      const correctDayName = getDayName(gptPost.scheduledDate);

      // Ensure caption contains at least one period
      let caption = gptPost.caption;
      if (!caption.includes(".")) {
        caption = caption + ".";
      }

      return {
        id: `post-${uuidv4()}`,
        mediaId: mediaItem.id,
        caption,
        hashtags: gptPost.hashtags.length > 0 ? gptPost.hashtags : ["#LOsteriaDeerlijk", "#LOsteria", "#Deerlijk"],
        scheduledDate: gptPost.scheduledDate,
        scheduledTime: gptPost.scheduledTime,
        dayName: correctDayName,
        sentiment: gptPost.sentiment,
        isOptimized: true,
        createdAt: Date.now(),
      };
    });

    // BUG-3 fix: If GPT returned fewer posts than images, generate fallback posts for missing ones
    const coveredMediaIds = new Set(posts.map((p) => p.mediaId));
    const missingImages = images.filter((img) => !coveredMediaIds.has(img.id));
    if (missingImages.length > 0) {
      console.log(`⚠️ GPT returned ${posts.length} posts for ${images.length} images. Generating ${missingImages.length} fallback(s).`);
      for (let i = 0; i < missingImages.length; i++) {
        posts.push(generateFallbackPost(missingImages[i], posts.length + i, today));
      }
    }

    console.log(`✅ Generated ${posts.length} posts successfully (${posts.length - missingImages.length} AI + ${missingImages.length} fallback)`);

    res.json({
      posts,
      planName: parsed.planName || `Content Plan - ${new Date().toLocaleDateString("nl-BE")}`,
      planDescription: parsed.planDescription || "AI-gegenereerd contentplan",
    });
  } catch (error: unknown) {
    console.error("❌ Error in /api/generate:", error);

    if (error instanceof OpenAI.APIError) {
      res.status(error.status || 500).json({
        error: "OpenAI API error",
        message: error.message,
        code: error.code,
      });
      return;
    }

    res.status(500).json({
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
});
