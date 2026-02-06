import { Router, Request, Response } from "express";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";
import { buildGeneratePrompt, BrandContext } from "../prompts/generate";
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import multer from "multer";

export const generateRouter = Router();

// ---------------------------------------------------------------------------
// Multer configuration: in-memory storage, 50 MB per file
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
 * Convert a Buffer to a base64 data URL.
 */
function bufferToDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

/**
 * Determine media type from MIME type.
 */
function mediaTypeFromMime(mime: string): "image" | "video" {
  if (mime.startsWith("video/")) return "video";
  return "image";
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
 * Extract video frames from a Buffer (for multer uploads).
 * Writes the buffer to a temp file, then calls extractVideoFrames.
 */
function extractVideoFramesFromBuffer(
  buffer: Buffer,
  mimeType: string,
  maxFrames: number = 1
): string[] {
  const dataUrl = bufferToDataUrl(buffer, mimeType);
  return extractVideoFrames(dataUrl, mimeType, maxFrames);
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

// ---------------------------------------------------------------------------
// Shared generation logic — called by both JSON and multipart handlers
// ---------------------------------------------------------------------------

async function handleGeneration(
  images: MediaItem[],
  brandIdentity: GenerateRequest["brandIdentity"],
  res: Response
): Promise<void> {
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
    maxRetries: 2,
    timeout: 60000,
  });

  // Build brand context
  const brandContext: BrandContext = {
    businessName: brandIdentity?.businessName || undefined,
    websiteUrl: brandIdentity?.websiteUrl,
    description: brandIdentity?.description,
    tone: undefined,
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

  // Add each image — validate format, resize if too large, log sizes
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    let imageUrl = normalizeImageDataUrl(img.base64, img.mimeType || "image/jpeg");
    let sizeBytes = base64ByteSize(imageUrl);
    let sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);

    // Server-side resize: if image > 4MB, use ffmpeg to downscale
    if (sizeBytes > 4 * 1024 * 1024) {
      console.log(`📐 Image ${i + 1} is ${sizeMB} MB — resizing to max 1920px...`);
      try {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "postagen-resize-"));
        const inputPath = path.join(tmpDir, "input.jpg");
        const outputPath = path.join(tmpDir, "output.jpg");

        const rawBase64 = imageUrl.includes(",") ? imageUrl.split(",")[1] : imageUrl;
        fs.writeFileSync(inputPath, Buffer.from(rawBase64, "base64"));

        execSync(
          `ffmpeg -y -i "${inputPath}" -vf "scale='min(1920,iw)':-2" -q:v 4 "${outputPath}"`,
          { timeout: 15000, stdio: "pipe" }
        );

        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
          const resizedBase64 = fs.readFileSync(outputPath).toString("base64");
          imageUrl = `data:image/jpeg;base64,${resizedBase64}`;
          sizeBytes = base64ByteSize(imageUrl);
          const newSizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);
          console.log(`📐 Resized: ${sizeMB} MB → ${newSizeMB} MB`);
          sizeMB = newSizeMB;
        }

        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (resizeErr) {
        console.warn(`⚠️ Could not resize image ${i + 1}, using original (${sizeMB} MB)`);
      }
    }

    console.log(
      `📷 Image ${i + 1}/${images.length}: ${sizeMB} MB | format: ${imageUrl.substring(0, 100)}...`
    );

    userContent.push({
      type: "image_url",
      image_url: {
        url: imageUrl,
        detail: images.length > 5 ? "low" : "auto",
      },
    });
  }

  console.log(`📸 Sending ${images.length} image(s) to GPT-4o for analysis...`);

  /**
   * Attempt a GPT call with the given detail level.
   */
  const attemptGPTCall = async (
    detail: "auto" | "high" | "low"
  ): Promise<string | null> => {
    const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      userContent[0],
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

  // --- Attempt 2: retry with detail=high ---
  if (!rawResponse) {
    console.log("🔄 Retrying with detail=high...");
    rawResponse = await attemptGPTCall("high");
  }

  // --- Attempt 3: retry with detail=low ---
  if (!rawResponse) {
    console.log("🔄 Retrying with detail=low...");
    rawResponse = await attemptGPTCall("low");
  }

  // Helper: compute correct dayName
  const DAY_NAMES = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
  const getDayName = (dateStr: string): string => {
    const date = new Date(dateStr + "T12:00:00");
    return DAY_NAMES[date.getDay()];
  };

  // Helper: generate fallback post
  const FALLBACK_TIMES = ["12:00 PM", "06:30 PM", "09:00 AM", "03:00 PM", "05:00 PM"];
  const generateFallbackPost = (
    mediaItem: MediaItem,
    index: number,
    startDate: string
  ) => {
    const date = new Date(startDate + "T12:00:00");
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

  // Parse JSON from response
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

  // Fill in missing posts for uncovered images
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
}

// ---------------------------------------------------------------------------
// POST /api/generate — multipart/form-data (primary) + JSON fallback
// ---------------------------------------------------------------------------

generateRouter.post(
  "/",
  // Multer runs first but only processes multipart requests.
  // For JSON requests, multer does nothing and we fall through.
  upload.array("files", 20),
  async (req: Request, res: Response) => {
    try {
      const contentType = req.headers["content-type"] || "";

      // ------------------------------------------------------------------
      // PATH A: Multipart/form-data (new — via multer)
      // ------------------------------------------------------------------
      if (contentType.includes("multipart/form-data")) {
        const uploadedFiles = req.files as Express.Multer.File[] | undefined;

        if (!uploadedFiles || uploadedFiles.length === 0) {
          res.status(400).json({
            error: "No media provided",
            message: "At least one file is required to generate posts.",
          });
          return;
        }

        // Parse brandIdentity from text field
        let brandIdentity: GenerateRequest["brandIdentity"];
        try {
          brandIdentity = req.body.brandIdentity
            ? JSON.parse(req.body.brandIdentity)
            : undefined;
        } catch {
          brandIdentity = undefined;
        }

        console.log(`📦 Received ${uploadedFiles.length} file(s) via multipart upload`);

        // Convert uploaded files to MediaItem[]
        const directImages: MediaItem[] = [];
        const videoFrameItems: MediaItem[] = [];

        for (let i = 0; i < uploadedFiles.length; i++) {
          const file = uploadedFiles[i];
          const fileId = `upload-${i}-${uuidv4().substring(0, 8)}`;
          const mime = file.mimetype;
          const type = mediaTypeFromMime(mime);

          console.log(`  📄 File ${i + 1}: ${file.originalname} (${mime}, ${(file.size / 1024 / 1024).toFixed(2)} MB)`);

          if (type === "video") {
            try {
              console.log(`🎬 Processing video: ${file.originalname}`);
              const frames = extractVideoFramesFromBuffer(file.buffer, mime, 1);
              if (frames.length > 0) {
                videoFrameItems.push({
                  id: fileId,
                  base64: frames[0],
                  type: "image",
                  mimeType: "image/jpeg",
                });
                console.log(`✅ Extracted ${frames.length} frame(s) from video ${file.originalname}`);
              } else {
                console.warn(`⚠️ No frames extracted from video ${file.originalname}`);
              }
            } catch (err) {
              console.error(`❌ Failed to process video ${file.originalname}:`, err);
            }
          } else {
            // Image (including HEIC — ffmpeg handles conversion during resize)
            const dataUrl = bufferToDataUrl(file.buffer, mime);
            directImages.push({
              id: fileId,
              base64: dataUrl,
              type: "image",
              mimeType: mime,
            });
          }
        }

        const allImages = [...directImages, ...videoFrameItems];

        if (allImages.length === 0) {
          res.status(400).json({
            error: "No processable media",
            message: "Could not process any of the provided media. Please try with images (JPEG/PNG) or shorter videos.",
          });
          return;
        }

        if (videoFrameItems.length > 0) {
          console.log(`📊 Media summary: ${directImages.length} images + ${videoFrameItems.length} video frames → ${allImages.length} processable items`);
        }

        await handleGeneration(allImages, brandIdentity, res);
        return;
      }

      // ------------------------------------------------------------------
      // PATH B: JSON body (legacy — backward compatible)
      // ------------------------------------------------------------------
      const { brandIdentity, media } = req.body as GenerateRequest;

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

      // Extract frames from videos
      const videoFrameItems: MediaItem[] = [];
      for (const video of videos) {
        try {
          console.log(`🎬 Processing video: ${video.id} (${video.mimeType})`);
          const frames = extractVideoFrames(video.base64, video.mimeType, 1);
          if (frames.length > 0) {
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

      await handleGeneration(images, brandIdentity, res);
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
  }
);
