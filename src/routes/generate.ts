import { Router, Request, Response } from "express";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";
import { buildGeneratePrompt, BrandContext } from "../prompts/generate";
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

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

/**
 * Validate and normalise a base64 data URL.
 * Ensures the format is `data:<mime>;base64,<payload>`.
 */
function normalizeImageDataUrl(raw: string, fallbackMime: string): string {
  if (raw.startsWith("data:")) {
    return raw;
  }
  // Raw base64 without data-URL prefix
  return `data:${fallbackMime || "image/jpeg"};base64,${raw}`;
}

/**
 * Return the byte-size of a base64 data URL payload.
 */
function base64ByteSize(dataUrl: string): number {
  const base64 = dataUrl.split(",")[1] || dataUrl;
  return Math.ceil((base64.length * 3) / 4);
}

/**
 * Extract key frames from a video using ffmpeg.
 * Returns an array of base64 data URLs (JPEG) for each extracted frame.
 * Strategy: extract up to `maxFrames` evenly spaced frames.
 * Each frame is resized to max 1024px wide to keep payloads manageable.
 */
function extractVideoFrames(
  videoDataUrl: string,
  mimeType: string,
  maxFrames: number = 1
): string[] {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "postagen-video-"));

  try {
    // Strip data URL prefix to get raw base64
    const base64Data = videoDataUrl.includes(",")
      ? videoDataUrl.split(",")[1]
      : videoDataUrl;

    // Determine file extension from mime type
    const ext = mimeType.includes("mp4")
      ? ".mp4"
      : mimeType.includes("webm")
        ? ".webm"
        : mimeType.includes("mov") || mimeType.includes("quicktime")
          ? ".mov"
          : ".mp4";

    const videoPath = path.join(tmpDir, `input${ext}`);
    fs.writeFileSync(videoPath, Buffer.from(base64Data, "base64"));

    const videoSize = fs.statSync(videoPath).size;
    console.log(`🎬 Video saved: ${(videoSize / 1024 / 1024).toFixed(2)} MB`);

    // Get video duration using ffprobe
    let duration = 1;
    try {
      const probeOutput = execSync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
        { timeout: 10000 }
      ).toString().trim();
      duration = parseFloat(probeOutput) || 1;
      console.log(`🎬 Video duration: ${duration.toFixed(1)}s`);
    } catch (e) {
      console.warn("⚠️ Could not probe video duration, using single frame");
    }

    // Calculate timestamps for evenly spaced frames
    const frameCount = Math.min(maxFrames, Math.max(1, Math.floor(duration / 2)));
    const timestamps: number[] = [];

    if (frameCount === 1) {
      // Single frame: take from 25% into the video (avoids black intro frames)
      timestamps.push(Math.min(duration * 0.25, duration - 0.1));
    } else {
      for (let i = 0; i < frameCount; i++) {
        const t = (duration / (frameCount + 1)) * (i + 1);
        timestamps.push(t);
      }
    }

    const frames: string[] = [];

    for (let i = 0; i < timestamps.length; i++) {
      const outputPath = path.join(tmpDir, `frame_${i}.jpg`);
      try {
        execSync(
          `ffmpeg -y -ss ${timestamps[i].toFixed(2)} -i "${videoPath}" -vframes 1 -vf "scale='min(1024,iw)':-2" -q:v 3 "${outputPath}"`,
          { timeout: 15000, stdio: "pipe" }
        );

        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
          const frameBase64 = fs.readFileSync(outputPath).toString("base64");
          frames.push(`data:image/jpeg;base64,${frameBase64}`);
          const frameSizeKB = (fs.statSync(outputPath).size / 1024).toFixed(0);
          console.log(`🖼️ Frame ${i + 1}/${timestamps.length}: ${frameSizeKB} KB at ${timestamps[i].toFixed(1)}s`);
        }
      } catch (e) {
        console.warn(`⚠️ Failed to extract frame at ${timestamps[i].toFixed(1)}s`);
      }
    }

    return frames;
  } finally {
    // Cleanup temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

/**
 * Check if a GPT response looks like a refusal rather than valid JSON.
 */
function isRefusal(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("i'm sorry") ||
    lower.includes("i can't assist") ||
    lower.includes("i cannot assist") ||
    lower.includes("i'm unable to") ||
    lower.includes("i cannot help") ||
    lower.includes("i can't help") ||
    lower.includes("as an ai") ||
    (lower.startsWith("i") && !lower.startsWith("{"))
  );
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

    // Separate images and videos
    const directImages = media.filter((m) => m.type === "image");
    const videos = media.filter((m) => m.type === "video");

    // Extract frames from videos and treat them as images
    const videoFrameItems: MediaItem[] = [];
    for (const video of videos) {
      try {
        console.log(`🎬 Processing video: ${video.id} (${video.mimeType})`);
        const frames = extractVideoFrames(video.base64, video.mimeType, 1);
        if (frames.length > 0) {
          // Use the first frame, keep the original video's ID so mediaId maps back
          videoFrameItems.push({
            id: video.id,
            base64: frames[0],
            type: "image",
            mimeType: "image/jpeg",
          });
          console.log(`✅ Extracted ${frames.length} frame(s) from video ${video.id}`);
        } else {
          console.warn(`⚠️ No frames extracted from video ${video.id}`);
        }
      } catch (err) {
        console.error(`❌ Failed to process video ${video.id}:`, err);
      }
    }

    // Combine direct images + video frames
    const images = [...directImages, ...videoFrameItems];

    if (images.length === 0) {
      res.status(400).json({
        error: "No processable media",
        message: "Could not process any of the provided media. Please try with images (JPEG/PNG) or shorter videos.",
      });
      return;
    }

    if (videos.length > 0) {
      console.log(`📊 Media summary: ${directImages.length} images + ${videos.length} videos → ${images.length} processable items`);
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
      businessName: brandIdentity?.businessName || undefined,
      websiteUrl: brandIdentity?.websiteUrl,
      description: brandIdentity?.description,
      tone: undefined, // Let the prompt use its own defaults
      languages: ["nl", "fr", "it"],
    };

    // Today's date for scheduling
    const today = new Date().toISOString().split("T")[0];
    const systemPrompt = buildGeneratePrompt(brandContext, images.length, today);

    // Build messages with images for GPT-4o Vision
    const businessLabel = brandContext.businessName || "het bedrijf";
    const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      {
        type: "text",
        text: `Hier zijn ${images.length} foto('s) van ${businessLabel}. Analyseer elke foto en genereer een social media post per foto. Antwoord ALLEEN met geldige JSON.`,
      },
    ];

    // Add each image — validate format and log sizes
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const imageUrl = normalizeImageDataUrl(img.base64, img.mimeType || "image/jpeg");
      const sizeBytes = base64ByteSize(imageUrl);
      const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);

      console.log(
        `📷 Image ${i + 1}/${images.length}: ${sizeMB} MB | format: ${imageUrl.substring(0, 100)}...`
      );

      // Warn for very large images (>15MB)
      if (sizeBytes > 15 * 1024 * 1024) {
        console.warn(
          `⚠️ Image ${i + 1} is very large (${sizeMB} MB) — this may cause issues.`
        );
      }

      userContent.push({
        type: "image_url",
        image_url: {
          url: imageUrl,
          detail: "auto", // Let GPT choose the right detail level
        },
      });
    }

    console.log(`📸 Sending ${images.length} image(s) to GPT-4o for analysis...`);

    /**
     * Attempt a GPT call with the given detail level.
     * Returns the raw content string or null.
     */
    const attemptGPTCall = async (
      detail: "auto" | "high" | "low"
    ): Promise<string | null> => {
      // Rebuild image content with specific detail level
      const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
        userContent[0], // text part
      ];
      for (const img of images) {
        const imageUrl = normalizeImageDataUrl(img.base64, img.mimeType || "image/jpeg");
        content.push({
          type: "image_url",
          image_url: { url: imageUrl, detail },
        });
      }

      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content },
        ],
        max_tokens: 4096,
        temperature: 0.8,
      });

      const raw = completion.choices[0]?.message?.content;
      if (!raw) return null;

      console.log(`🤖 GPT response (detail=${detail}):`, raw.substring(0, 300));

      if (isRefusal(raw)) {
        console.warn(`⚠️ GPT refused with detail="${detail}": ${raw.substring(0, 200)}`);
        return null;
      }

      return raw;
    };

    // --- Attempt 1: detail=auto ---
    let rawResponse = await attemptGPTCall("auto");

    // --- Attempt 2: retry with detail=high if first attempt was refused ---
    if (!rawResponse) {
      console.log("🔄 Retrying with detail=high...");
      rawResponse = await attemptGPTCall("high");
    }

    // --- Attempt 3: retry with detail=low ---
    if (!rawResponse) {
      console.log("🔄 Retrying with detail=low...");
      rawResponse = await attemptGPTCall("low");
    }

    // Helper: compute correct dayName from a date string (never trust GPT for this)
    const DAY_NAMES = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
    const getDayName = (dateStr: string): string => {
      const date = new Date(dateStr + "T12:00:00"); // noon to avoid timezone issues
      return DAY_NAMES[date.getDay()];
    };

    // Helper: generate fallback post for a media item
    const FALLBACK_TIMES = ["12:00 PM", "06:30 PM", "09:00 AM", "03:00 PM", "05:00 PM"];
    const generateFallbackPost = (
      mediaItem: MediaItem,
      index: number,
      startDate: string
    ) => {
      const date = new Date(startDate + "T12:00:00");
      // Skip Monday (1) and Sunday (0)
      let daysAdded = 0;
      let offset = index;
      while (daysAdded <= offset) {
        date.setDate(date.getDate() + 1);
        const day = date.getDay();
        if (day !== 0 && day !== 1) daysAdded++;
      }
      const dateStr = date.toISOString().split("T")[0];
      const label = brandContext.businessName || "ons bedrijf";
      return {
        id: `post-${uuidv4()}`,
        mediaId: mediaItem.id,
        caption: `Ontdek wat ${label} te bieden heeft. Bekijk onze nieuwste content en laat je inspireren! ✨`,
        hashtags: ["#ContentPlan", "#SocialMedia", "#AIGenerated"],
        scheduledDate: dateStr,
        scheduledTime: FALLBACK_TIMES[index % FALLBACK_TIMES.length],
        dayName: getDayName(dateStr),
        sentiment: "Very Positive" as const,
        isOptimized: true,
        createdAt: Date.now(),
      };
    };

    // --- If GPT still refused after all retries, generate fallback posts ---
    if (!rawResponse) {
      console.warn("❌ GPT refused all attempts. Generating fallback posts for all images.");
      const fallbackPosts = images.map((img, i) =>
        generateFallbackPost(img, i, today)
      );

      res.json({
        posts: fallbackPosts,
        planName: `Content Plan - ${new Date().toLocaleDateString("nl-BE")}`,
        planDescription: "AI-gegenereerd contentplan (fallback — beelden konden niet worden geanalyseerd)",
      });
      return;
    }

    console.log("🤖 Raw GPT response:", rawResponse);

    // Parse JSON from response (handle potential markdown code blocks)
    let parsed: GPTResponse;
    try {
      let jsonStr = rawResponse.trim();
      if (jsonStr.startsWith("```")) {
        jsonStr = jsonStr.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
      }
      parsed = JSON.parse(jsonStr);
    } catch (parseError) {
      console.error("❌ Failed to parse GPT response:", parseError);
      console.error("Raw response was:", rawResponse);

      // Generate fallback posts instead of returning 500
      console.warn("⚠️ Generating fallback posts due to parse failure.");
      const fallbackPosts = images.map((img, i) =>
        generateFallbackPost(img, i, today)
      );

      res.json({
        posts: fallbackPosts,
        planName: `Content Plan - ${new Date().toLocaleDateString("nl-BE")}`,
        planDescription: "AI-gegenereerd contentplan (fallback — antwoord kon niet worden verwerkt)",
      });
      return;
    }

    // Map GPT response to frontend Post interface
    const posts = parsed.posts.map((gptPost) => {
      const mediaItem = images[gptPost.mediaIndex] || images[0];
      const correctDayName = getDayName(gptPost.scheduledDate);

      let caption = gptPost.caption;
      if (!caption.includes(".")) {
        caption = caption + ".";
      }

      return {
        id: `post-${uuidv4()}`,
        mediaId: mediaItem.id,
        caption,
        hashtags:
          gptPost.hashtags.length > 0
            ? gptPost.hashtags
            : ["#ContentPlan", "#SocialMedia"],
        scheduledDate: gptPost.scheduledDate,
        scheduledTime: gptPost.scheduledTime,
        dayName: correctDayName,
        sentiment: gptPost.sentiment,
        isOptimized: true,
        createdAt: Date.now(),
      };
    });

    // If GPT returned fewer posts than images, generate fallback posts for missing ones
    const coveredMediaIds = new Set(posts.map((p) => p.mediaId));
    const missingImages = images.filter((img) => !coveredMediaIds.has(img.id));
    if (missingImages.length > 0) {
      console.log(
        `⚠️ GPT returned ${posts.length} posts for ${images.length} images. Generating ${missingImages.length} fallback(s).`
      );
      for (let i = 0; i < missingImages.length; i++) {
        posts.push(generateFallbackPost(missingImages[i], posts.length + i, today));
      }
    }

    console.log(
      `✅ Generated ${posts.length} posts successfully (${posts.length - missingImages.length} AI + ${missingImages.length} fallback)`
    );

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
