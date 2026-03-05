import { Router, Request, Response } from "express";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";
import { buildGeneratePrompt, BrandContext, ContentContext } from "../prompts/generate";
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
  videoId?: string; // For video frames: ID of the source video
  frameIndex?: number; // For video frames: which frame this is
  thumbnail?: string; // For videos: extracted frame as thumbnail/poster
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
  postType?: "feed" | "story" | "reel";
  caption: string;
  hashtags: string[];
  platformTip?: string;
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
 * 
 * STRATEGY (Based on OpenAI Best Practices):
 * - Extract 1 frame every 2-3 seconds (max 10 frames)
 * - Skip first/last 10% to avoid intro/outro artifacts
 * - Frames compressed to 512px max, quality 10
 * - Multiple frames give GPT better video understanding
 * 
 * OPTIMIZATION: Aggressive compression (~90% size reduction)
 * Original high-quality video is preserved in frontend for display.
 */
function extractVideoFrames(
  videoDataUrl: string,
  mimeType: string,
  maxFrames: number = 10
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

    // Get video duration using ffprobe (try multiple paths for cross-platform support)
    let duration = 1;
    const ffprobePaths = [
      'ffprobe',                           // System PATH
      '/opt/homebrew/bin/ffprobe',        // Homebrew on Apple Silicon
      '/usr/local/bin/ffprobe',           // Homebrew on Intel Mac
    ];
    
    let ffprobeCmd = 'ffprobe';
    for (const probePath of ffprobePaths) {
      try {
        execSync(`${probePath} -version`, { stdio: 'pipe', timeout: 1000 });
        ffprobeCmd = probePath;
        console.log(`✅ Found ffprobe at: ${probePath}`);
        break;
      } catch {
        continue;
      }
    }
    
    try {
      const probeOutput = execSync(
        `${ffprobeCmd} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
        { timeout: 10000 }
      ).toString().trim();
      duration = parseFloat(probeOutput) || 1;
      console.log(`🎬 Video duration: ${duration.toFixed(1)}s`);
    } catch (e) {
      console.warn("⚠️ Could not probe video duration, using single frame");
    }

    // Extract frames strategically based on OpenAI best practices
    // For videos: extract 1 frame every 2-3 seconds (max 10 frames to keep costs reasonable)
    const FRAME_INTERVAL = 2.5; // Extract frame every 2.5 seconds
    const MAX_FRAMES = 10; // Limit to 10 frames for cost control
    
    const frameCount = Math.min(
      maxFrames,
      MAX_FRAMES,
      Math.max(1, Math.floor(duration / FRAME_INTERVAL))
    );
    
    const timestamps: number[] = [];

    if (duration < 3) {
      // Short video (<3s): take 1 frame from middle
      timestamps.push(duration * 0.5);
    } else if (frameCount === 1) {
      // Single frame: take from 30% into the video (avoids black intro frames)
      timestamps.push(Math.min(duration * 0.3, duration - 0.5));
    } else {
      // Multiple frames: evenly distributed throughout video
      for (let i = 0; i < frameCount; i++) {
        // Skip first 10% and last 10% to avoid intro/outro artifacts
        const start = duration * 0.1;
        const end = duration * 0.9;
        const range = end - start;
        const t = start + (range / (frameCount - 1)) * i;
        timestamps.push(t);
      }
    }
    
    console.log(`🎯 Extracting ${frameCount} frame(s) at: ${timestamps.map(t => t.toFixed(1) + 's').join(', ')}`);

    // Find ffmpeg executable (try multiple paths for cross-platform support)
    const ffmpegPaths = [
      'ffmpeg',                           // System PATH
      '/opt/homebrew/bin/ffmpeg',        // Homebrew on Apple Silicon
      '/usr/local/bin/ffmpeg',           // Homebrew on Intel Mac
    ];
    
    let ffmpegCmd = 'ffmpeg';
    for (const ffmpegPath of ffmpegPaths) {
      try {
        execSync(`${ffmpegPath} -version`, { stdio: 'pipe', timeout: 1000 });
        ffmpegCmd = ffmpegPath;
        console.log(`✅ Found ffmpeg at: ${ffmpegPath}`);
        break;
      } catch {
        continue;
      }
    }

    const frames: string[] = [];

    for (let i = 0; i < timestamps.length; i++) {
      const outputPath = path.join(tmpDir, `frame_${i}.jpg`);
      try {
        // Aggressive compression: 512px max, quality 10 (same as image compression)
        execSync(
          `${ffmpegCmd} -y -ss ${timestamps[i].toFixed(2)} -i "${videoPath}" -vframes 1 -vf "scale='min(512,iw)':-2" -q:v 10 "${outputPath}"`,
          { timeout: 15000, stdio: "pipe" }
        );

        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
          const frameBase64 = fs.readFileSync(outputPath).toString("base64");
          frames.push(`data:image/jpeg;base64,${frameBase64}`);
          const frameSizeKB = (fs.statSync(outputPath).size / 1024).toFixed(0);
          console.log(`🗜️  Video frame ${i + 1}/${timestamps.length}: ${frameSizeKB}KB (compressed for GPT) at ${timestamps[i].toFixed(1)}s`);
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
 * Convert video to MP4 format for universal browser playback.
 * Returns a base64-encoded MP4 data URL.
 */
function convertVideoToMP4(buffer: Buffer, mimeType: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "postagen-convert-"));
  
  try {
    // Determine input file extension
    const inputExt = mimeType.includes("mp4")
      ? ".mp4"
      : mimeType.includes("webm")
        ? ".webm"
        : mimeType.includes("mov") || mimeType.includes("quicktime")
          ? ".mov"
          : ".mp4";
    
    const inputPath = path.join(tmpDir, `input${inputExt}`);
    const outputPath = path.join(tmpDir, "output.mp4");
    
    fs.writeFileSync(inputPath, buffer);
    
    // Find ffmpeg
    const ffmpegPaths = [
      'ffmpeg',
      '/opt/homebrew/bin/ffmpeg',
      '/usr/local/bin/ffmpeg',
    ];
    
    let ffmpegCmd = 'ffmpeg';
    for (const ffmpegPath of ffmpegPaths) {
      try {
        execSync(`${ffmpegPath} -version`, { stdio: 'pipe', timeout: 1000 });
        ffmpegCmd = ffmpegPath;
        break;
      } catch {
        continue;
      }
    }
    
    console.log(`🔄 Converting video to MP4 (${(buffer.length / 1024 / 1024).toFixed(2)}MB)...`);
    
    // Convert to MP4 with H.264 codec (universal browser support)
    // Max 1920px to keep file size reasonable
    execSync(
      `${ffmpegCmd} -y -i "${inputPath}" -vf "scale='min(1920,iw)':-2" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k "${outputPath}"`,
      { timeout: 60000, stdio: 'pipe' }
    );
    
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
      const mp4Base64 = fs.readFileSync(outputPath).toString("base64");
      const mp4DataUrl = `data:video/mp4;base64,${mp4Base64}`;
      
      const originalSize = (buffer.length / 1024 / 1024).toFixed(2);
      const convertedSize = (Buffer.from(mp4Base64, "base64").length / 1024 / 1024).toFixed(2);
      console.log(`✅ Converted to MP4: ${originalSize}MB → ${convertedSize}MB`);
      
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return mp4DataUrl;
    }
    
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error("MP4 conversion failed");
  } catch (err) {
    console.error("❌ Video conversion failed:", err);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Extract video frames from a Buffer (for multer uploads).
 * Writes the buffer to a temp file, then calls extractVideoFrames.
 * 
 * OPTIMIZATION: Uses aggressive compression (512px max) for GPT analysis
 * while preserving original high-quality video in frontend.
 */
function extractVideoFramesFromBuffer(
  buffer: Buffer,
  mimeType: string,
  maxFrames: number = 10
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

/**
 * Aggressively compress image for GPT analysis (512px max, lower quality).
 * This dramatically speeds up GPT processing and reduces costs.
 * Note: Video frames are already compressed during extraction, so they skip this.
 */
function compressImageForGPT(base64DataUrl: string, mimeType: string): string {
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "postagen-gpt-compress-"));
    const inputPath = path.join(tmpDir, "input.jpg");
    const outputPath = path.join(tmpDir, "output.jpg");

    const rawBase64 = base64DataUrl.includes(",") 
      ? base64DataUrl.split(",")[1] 
      : base64DataUrl;
    fs.writeFileSync(inputPath, Buffer.from(rawBase64, "base64"));

    // Find ffmpeg executable (try multiple paths for cross-platform support)
    const ffmpegPaths = [
      'ffmpeg',                           // System PATH
      '/opt/homebrew/bin/ffmpeg',        // Homebrew on Apple Silicon
      '/usr/local/bin/ffmpeg',           // Homebrew on Intel Mac
    ];
    
    let ffmpegCmd = 'ffmpeg';
    for (const ffmpegPath of ffmpegPaths) {
      try {
        execSync(`${ffmpegPath} -version`, { stdio: 'pipe', timeout: 1000 });
        ffmpegCmd = ffmpegPath;
        break;
      } catch {
        continue;
      }
    }

    // Aggressive compression: 512px max, quality 10 (lower = more compression)
    execSync(
      `${ffmpegCmd} -y -i "${inputPath}" -vf "scale='min(512,iw)':-2" -q:v 10 "${outputPath}"`,
      { timeout: 10000, stdio: "pipe" }
    );

    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
      const compressedBase64 = fs.readFileSync(outputPath).toString("base64");
      fs.rmSync(tmpDir, { recursive: true, force: true });
      
      const originalSize = (base64ByteSize(base64DataUrl) / 1024).toFixed(0);
      const compressedSize = (Buffer.from(compressedBase64, "base64").length / 1024).toFixed(0);
      console.log(`🗜️  Compressed for GPT: ${originalSize}KB → ${compressedSize}KB`);
      
      return `data:image/jpeg;base64,${compressedBase64}`;
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
    return normalizeImageDataUrl(base64DataUrl, mimeType);
  } catch (err) {
    console.warn(`⚠️ Could not compress image for GPT, using original:`, err);
    return normalizeImageDataUrl(base64DataUrl, mimeType);
  }
}

/**
 * Extended MediaItem to track both original and compressed versions
 */
interface ProcessedMediaItem extends MediaItem {
  compressedForGPT: string; // Heavily compressed version for GPT analysis
  originalBase64: string;    // Original high-quality image from frontend
}

// ---------------------------------------------------------------------------
// Shared generation logic — called by both JSON and multipart handlers
// 
// OPTIMIZATION STRATEGY (Based on OpenAI Best Practices):
// 1. Receives high-quality images/videos from frontend
// 2. Creates aggressively compressed versions (512px max) for GPT analysis
//    - Images: compressed to 512px, quality 10
//    - Videos: extract multiple frames (1 every 2-3s, max 10) at 512px, quality 10
// 3. Sends all compressed media in single request
//    - Multiple video frames give GPT comprehensive understanding of video content
//    - Each frame treated as separate image for analysis
// 4. Maps results back to ORIGINAL high-quality media
// 
// This approach dramatically improves speed (3-5x faster) and reduces costs
// (~90% smaller media) while maintaining quality for the end user.
// Reference: OpenAI Video Processing Cookbook (2025)
// ---------------------------------------------------------------------------

async function handleGeneration(
  images: MediaItem[],
  brandIdentity: GenerateRequest["brandIdentity"],
  res: Response,
  videoMetadata?: Map<string, { originalId: string; frameCount: number }>,
  allMediaForFrontend?: MediaItem[],
  contentContext?: ContentContext,
  libraryIdMap?: Map<string, string>
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
    timeout: 180000, // 3 minutes - increased for vision API with multiple images
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
  
  console.log(`📥 Processing ${images.length} media items...`);

  // Step 1: Process all images - create compressed versions for GPT, keep originals
  const processedImages: ProcessedMediaItem[] = images.map((img, i) => {
    const originalBase64 = normalizeImageDataUrl(img.base64, img.mimeType || "image/jpeg");
    const compressedForGPT = compressImageForGPT(originalBase64, img.mimeType || "image/jpeg");
    
    const itemType = img.videoId ? `video frame ${img.frameIndex! + 1}` : 'image';
    console.log(`📷 ${itemType} ${i + 1}/${images.length} processed (ID: ${img.id})`);
    
    return {
      ...img,
      originalBase64,      // Keep high-quality original for final response
      compressedForGPT,    // Use compressed version for GPT analysis
    };
  });

  // Step 2: Group video frames and count unique media items
  const videoGroups: Map<string, ProcessedMediaItem[]> = new Map();
  const standaloneImages: ProcessedMediaItem[] = [];
  
  processedImages.forEach(img => {
    if (img.videoId) {
      if (!videoGroups.has(img.videoId)) {
        videoGroups.set(img.videoId, []);
      }
      videoGroups.get(img.videoId)!.push(img);
    } else {
      standaloneImages.push(img);
    }
  });
  
  const uniqueMediaCount = standaloneImages.length + videoGroups.size;
  console.log(`📊 Unique media: ${standaloneImages.length} images + ${videoGroups.size} videos = ${uniqueMediaCount} posts to generate`);
  
  // Build media index map early for fallback handling
  const mediaIndexMap: Array<string> = [];
  standaloneImages.forEach(img => mediaIndexMap.push(img.id));
  videoGroups.forEach((frames, videoId) => mediaIndexMap.push(videoId));

  // Step 3: Build system prompt for UNIQUE media count
  const systemPrompt = buildGeneratePrompt(brandContext, uniqueMediaCount, today, contentContext);
  const businessLabel = brandContext.businessName || "het bedrijf";

  let promptText = `Hier zijn media van ${businessLabel}:\n`;
  promptText += `- ${standaloneImages.length} foto${standaloneImages.length !== 1 ? "'s" : ""}\n`;
  if (videoGroups.size > 0) {
    promptText += `- ${videoGroups.size} video${videoGroups.size !== 1 ? "'s" : ""} (met meerdere frames per video)\n\n`;
    promptText += `BELANGRIJK: Voor elke video zijn er meerdere frames getoond. Analyseer ALLE frames van een video samen en genereer ÉÉN post per video (niet per frame).\n\n`;
  }
  promptText += `Genereer ${uniqueMediaCount} social media posts (1 per foto/video). Antwoord ALLEEN met geldige JSON.`;

  const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    {
      type: "text",
      text: promptText,
    },
  ];

  // Add compressed images (videos grouped together)
  let mediaIndex = 0;
  
  // Add standalone images first
  standaloneImages.forEach((img) => {
    console.log(`📤 Adding image ${mediaIndex + 1} to GPT request (ID: ${img.id})`);
    userContent.push({
      type: "image_url",
      image_url: {
        url: img.compressedForGPT,
        detail: "low",
      },
    });
    mediaIndex++;
  });
  
  // Add video frames (grouped)
  videoGroups.forEach((frames, videoId) => {
    console.log(`📤 Adding video ${mediaIndex + 1} with ${frames.length} frames to GPT request (ID: ${videoId})`);
    frames.forEach((frame, idx) => {
      userContent.push({
        type: "image_url",
        image_url: {
          url: frame.compressedForGPT,
          detail: "low",
        },
      });
    });
    mediaIndex++;
  });

  console.log(`📸 Sending ${uniqueMediaCount} media items (${processedImages.length} total frames) to GPT-4o...`);

  // Step 3: Attempt GPT call with retry logic
  const attemptGPTCall = async (detail: "low" = "low"): Promise<string | null> => {
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
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
    } catch (error) {
      console.error(`❌ Error calling GPT:`, error);
      return null;
    }
  };

  // Try to get response (with retries)
  let rawResponse = await attemptGPTCall();
  if (!rawResponse) {
    console.log("🔄 Retrying GPT call...");
    rawResponse = await attemptGPTCall();
  }
  if (!rawResponse) {
    console.log("🔄 Final retry...");
    rawResponse = await attemptGPTCall();
  }

  // Step 4: Parse response and map back to original images

  // Helper functions
  const DAY_NAMES = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
  const getDayName = (dateStr: string): string => {
    const date = new Date(dateStr + "T12:00:00");
    return DAY_NAMES[date.getDay()];
  };

  const FALLBACK_TIMES = ["12:00 PM", "06:30 PM", "09:00 AM", "03:00 PM", "05:00 PM"];
  const generateFallbackPost = (
    mediaItem: ProcessedMediaItem,
    index: number,
    startDate: string,
    videoId?: string
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
    
    // Get thumbnail if this is a video
    let thumbnail: string | undefined;
    if (videoId) {
      const videoFrames = videoGroups.get(videoId);
      if (videoFrames && videoFrames.length > 0) {
        thumbnail = videoFrames[0].compressedForGPT;
      }
    }
    
    return {
      id: `post-${uuidv4()}`,
      mediaId: mediaItem.id,
      realMediaId: libraryIdMap?.get(mediaItem.id) || null,
      postType: "feed" as const,
      caption: `Ontdek wat ${label} te bieden heeft. Bekijk onze nieuwste content en laat je inspireren! ✨`,
      hashtags: ["#ContentPlan", "#SocialMedia", "#AIGenerated"],
      platformTip: "",
      scheduledDate: dateStr,
      scheduledTime: FALLBACK_TIMES[index % FALLBACK_TIMES.length],
      dayName: getDayName(dateStr),
      sentiment: "Very Positive" as const,
      isOptimized: true,
      createdAt: Date.now(),
      thumbnail,
    };
  };

  // If GPT failed all retries, generate fallback posts for unique media items
  if (!rawResponse) {
    console.warn("❌ GPT refused all attempts. Generating fallback posts for all media.");
    const fallbackPosts = mediaIndexMap.map((mediaId, i) => {
      const mediaItem = processedImages.find(img => 
        img.id === mediaId || img.videoId === mediaId
      ) || processedImages[0];
      
      const isVideo = videoGroups.has(mediaId);
      const post = generateFallbackPost(mediaItem, i, today, isVideo ? mediaId : undefined);
      post.mediaId = mediaId; // Use correct video/image ID
      return post;
    });

    // Include converted videos in response
    const convertedVideosForResponse = (allMediaForFrontend || [])
      .filter(m => m.type === "video")
      .map(v => ({
        id: v.id,
        base64: v.base64,
        mimeType: v.mimeType,
        type: v.type as "video"
      }));

    res.json({
      posts: fallbackPosts,
      planName: `Content Plan - ${new Date().toLocaleDateString("nl-BE")}`,
      planDescription: "AI-gegenereerd contentplan (fallback — beelden konden niet worden geanalyseerd)",
      convertedVideos: convertedVideosForResponse.length > 0 ? convertedVideosForResponse : undefined,
    });
    return;
  }

  console.log("🤖 Raw GPT response received, parsing...");

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
    const fallbackPosts = mediaIndexMap.map((mediaId, i) => {
      const mediaItem = processedImages.find(img => 
        img.id === mediaId || img.videoId === mediaId
      ) || processedImages[0];
      
      const isVideo = videoGroups.has(mediaId);
      const post = generateFallbackPost(mediaItem, i, today, isVideo ? mediaId : undefined);
      post.mediaId = mediaId; // Use correct video/image ID
      return post;
    });

    // Include converted videos in response
    const convertedVideosForResponse = (allMediaForFrontend || [])
      .filter(m => m.type === "video")
      .map(v => ({
        id: v.id,
        base64: v.base64,
        mimeType: v.mimeType,
        type: v.type as "video"
      }));

    res.json({
      posts: fallbackPosts,
      planName: `Content Plan - ${new Date().toLocaleDateString("nl-BE")}`,
      planDescription: "AI-gegenereerd contentplan (fallback — antwoord kon niet worden verwerkt)",
      convertedVideos: convertedVideosForResponse.length > 0 ? convertedVideosForResponse : undefined,
    });
    return;
  }

  // Map GPT posts to final format with ORIGINAL high-quality images/videos
  console.log(`🗺️  Media index map:`, mediaIndexMap);
  
  const posts = parsed.posts.map((gptPost) => {
    // Map mediaIndex to actual media ID (video or image)
    const actualMediaId = mediaIndexMap[gptPost.mediaIndex] || mediaIndexMap[0];
    const correctDayName = getDayName(gptPost.scheduledDate);

    let caption = gptPost.caption;
    if (!caption.includes(".")) {
      caption = caption + ".";
    }
    
    // Check if this is a video and get its thumbnail
    let thumbnail: string | undefined;
    const videoFrames = videoGroups.get(actualMediaId);
    if (videoFrames && videoFrames.length > 0) {
      // Use the first frame as thumbnail
      thumbnail = videoFrames[0].compressedForGPT;
      console.log(`📝 Post ${gptPost.mediaIndex} → Video ID: ${actualMediaId} (with ${videoFrames.length} frames, thumbnail included)`);
    } else {
      console.log(`📝 Post ${gptPost.mediaIndex} → Image ID: ${actualMediaId}`);
    }

    return {
      id: `post-${uuidv4()}`,
      mediaId: actualMediaId, // Uses original video/image ID (not frame ID)
      realMediaId: libraryIdMap?.get(actualMediaId) || null, // Real Supabase UUID for library items
      postType: gptPost.postType || "feed",
      caption,
      hashtags:
        gptPost.hashtags && gptPost.hashtags.length > 0
          ? gptPost.hashtags
          : ["#ContentPlan", "#SocialMedia"],
      platformTip: gptPost.platformTip || "",
      scheduledDate: gptPost.scheduledDate,
      scheduledTime: gptPost.scheduledTime,
      dayName: correctDayName,
      sentiment: gptPost.sentiment || "Neutral",
      isOptimized: true,
      createdAt: Date.now(),
      thumbnail, // Include thumbnail for videos
    };
  });

  // Fill in missing posts for uncovered media (check against unique media IDs, not frames)
  const coveredMediaIds = new Set(posts.map((p) => p.mediaId));
  const missingMediaIds = mediaIndexMap.filter(id => !coveredMediaIds.has(id));
  
  if (missingMediaIds.length > 0) {
    console.log(
      `⚠️ GPT returned ${posts.length} posts for ${uniqueMediaCount} media items. Generating ${missingMediaIds.length} fallback(s).`
    );
    
    missingMediaIds.forEach((mediaId, i) => {
      // Find a representative item for this media (use first frame if video)
      const mediaItem = processedImages.find(img => 
        img.id === mediaId || img.videoId === mediaId
      ) || processedImages[0];
      
      // Check if this is a video
      const isVideo = videoGroups.has(mediaId);
      
      // For fallback, use the video ID or image ID
      const fallbackPost = generateFallbackPost(mediaItem, posts.length + i, today, isVideo ? mediaId : undefined);
      fallbackPost.mediaId = mediaId; // Ensure we use the correct video/image ID
      posts.push(fallbackPost);
    });
  }

  console.log(
    `✅ Generated ${posts.length} posts successfully (${parsed.posts.length} AI + ${missingMediaIds.length} fallback)`
  );

  // Include converted videos in response so frontend can update IndexedDB
  const convertedVideosForResponse = (allMediaForFrontend || [])
    .filter(m => m.type === "video")
    .map(v => ({
      id: v.id,
      base64: v.base64,
      mimeType: v.mimeType,
      type: v.type as "video"
    }));

  res.json({
    posts,
    planName: parsed.planName || `Content Plan - ${new Date().toLocaleDateString("nl-BE")}`,
    planDescription: parsed.planDescription || "AI-gegenereerd contentplan met slimme beeldanalyse",
    convertedVideos: convertedVideosForResponse.length > 0 ? convertedVideosForResponse : undefined,
  });
}

// ---------------------------------------------------------------------------
// POST /api/generate — multipart/form-data (primary) + JSON fallback
// ---------------------------------------------------------------------------

// Custom multer error handler middleware
function multerUpload(req: Request, res: Response, next: Function) {
  // Use .any() to accept files from ANY field name (avoids LIMIT_UNEXPECTED_FILE)
  const anyUpload = upload.any();
  anyUpload(req, res, (err: any) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({
          error: "File too large",
          message: "Een of meer bestanden zijn te groot. Maximum 50MB per bestand.",
        });
        return;
      }
      if (err.code === "LIMIT_UNEXPECTED_FILE") {
        // Should no longer happen with .any(), but handle gracefully
        console.warn(`⚠️ Multer unexpected field: ${err.field}. Accepting anyway with .any()`);
      }
      if (err.code && err.code.startsWith("LIMIT_")) {
        res.status(400).json({
          error: "Upload error",
          message: `Upload probleem: ${err.message}`,
        });
        return;
      }
      console.error("❌ Multer error:", err);
      res.status(500).json({
        error: "Upload failed",
        message: "Er ging iets mis bij het uploaden. Probeer het opnieuw.",
      });
      return;
    }
    next();
  });
}

generateRouter.post(
  "/",
  multerUpload,
  async (req: Request, res: Response) => {
    try {
      const contentType = req.headers["content-type"] || "";

      // ------------------------------------------------------------------
      // PATH A: Multipart/form-data (new — via multer)
      // ------------------------------------------------------------------
      if (contentType.includes("multipart/form-data")) {
        // .any() puts all files in req.files regardless of field name
        const uploadedFiles = req.files as Express.Multer.File[] | undefined;

        // Parse mediaUrls (Supabase library items) early — needed for validation
        const mediaUrls: string[] = [];
        if (req.body.mediaUrls) {
          // Could be a single string or array
          const urls = Array.isArray(req.body.mediaUrls)
            ? req.body.mediaUrls
            : [req.body.mediaUrls];
          mediaUrls.push(...urls.filter((u: string) => u && u.startsWith("http")));
        }

        // Parse mediaIds (real Supabase UUIDs parallel to mediaUrls)
        const mediaIds: string[] = [];
        if (req.body.mediaIds) {
          const ids = Array.isArray(req.body.mediaIds)
            ? req.body.mediaIds
            : [req.body.mediaIds];
          mediaIds.push(...ids.filter((id: string) => id));
        }

        // Build mapping: library-X-xxx → real Supabase UUID
        const libraryIdMap = new Map<string, string>();

        const fileCount = uploadedFiles?.length ?? 0;
        if (fileCount === 0 && mediaUrls.length === 0) {
          res.status(400).json({
            error: "No media provided",
            message: "At least one file or media URL is required to generate posts.",
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

        // Parse content context fields
        const contentContext: ContentContext | undefined = req.body.language
          ? {
              language: (req.body.language as "nl" | "fr" | "en") || "nl",
              weeklyContext: req.body.weeklyContext || undefined,
              specialMessage: req.body.specialMessage || undefined,
            }
          : undefined;

        console.log(`📦 Received ${fileCount} file(s) via multipart upload`);
        if (mediaUrls.length > 0) {
          console.log(`📎 Also received ${mediaUrls.length} media URL(s) from library`);
        }
        if (contentContext) {
          console.log(`🌐 Language: ${contentContext.language}, Context: ${contentContext.weeklyContext ? 'yes' : 'no'}, Message: ${contentContext.specialMessage ? 'yes' : 'no'}`);
        }

        // Convert uploaded files to MediaItem[]
        const directImages: MediaItem[] = [];
        const videoFrameItems: MediaItem[] = [];
        const convertedVideos: MediaItem[] = []; // MP4 videos for frontend (not sent to GPT)
        const videoMetadata: Map<string, { originalId: string; frameCount: number }> = new Map();

        for (let i = 0; i < (uploadedFiles?.length ?? 0); i++) {
          const file = uploadedFiles![i];
          
          // Extract media ID from filename (format: "media-123456789.jpg")
          // The frontend sends filename as: `${mediaId}${extension}`
          const fileId = file.originalname.split('.')[0] || `upload-${i}-${uuidv4().substring(0, 8)}`;
          const mime = file.mimetype;
          const type = mediaTypeFromMime(mime);

          console.log(`  📄 File ${i + 1}: ${file.originalname} → ID: ${fileId} (${mime}, ${(file.size / 1024 / 1024).toFixed(2)} MB)`);

          if (type === "video") {
            try {
              console.log(`🎬 Processing video: ${file.originalname}`);
              
              // Step 1: Convert video to MP4 for browser playback
              const mp4DataUrl = convertVideoToMP4(file.buffer, mime);
              
              // Step 2: Extract frames for GPT analysis
              const frames = extractVideoFramesFromBuffer(file.buffer, mime, 10);
              
              if (frames.length > 0) {
                // Store video metadata for later mapping
                videoMetadata.set(fileId, {
                  originalId: fileId,
                  frameCount: frames.length
                });
                
                // Save the first frame as thumbnail
                const thumbnail = frames[0];
                
                // Add ALL frames as separate items for comprehensive video understanding
                // But mark them as belonging to this video
                frames.forEach((frame, idx) => {
                  videoFrameItems.push({
                    id: `${fileId}-frame-${idx}`,
                    base64: frame,
                    type: "image",
                    mimeType: "image/jpeg",
                    videoId: fileId, // Link frame back to original video
                    frameIndex: idx,
                    thumbnail: idx === 0 ? thumbnail : undefined, // First frame is thumbnail
                  });
                });
                
                // Add the converted MP4 video to a SEPARATE array (NOT sent to GPT)
                // This MP4 will be returned to frontend for display/storage
                convertedVideos.push({
                  id: fileId,
                  base64: mp4DataUrl,
                  type: "video",
                  mimeType: "video/mp4", // Always MP4 for browser compatibility
                });
                
                console.log(`✅ Video ${file.originalname}: Converted to MP4 + Extracted ${frames.length} frames for analysis`);
              } else {
                console.warn(`⚠️ No frames extracted from video ${file.originalname}. Video will be skipped.`);
              }
            } catch (err: any) {
              console.error(`❌ Failed to process video ${file.originalname}:`, err?.message || err);
              if (err?.message?.includes('ffmpeg') || err?.message?.includes('ffprobe')) {
                console.error(`💡 FFmpeg not found. Install it with: brew install ffmpeg`);
              }
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

        // Download and process media URLs from Supabase library
        for (let i = 0; i < mediaUrls.length; i++) {
          const url = mediaUrls[i];
          try {
            console.log(`📥 Downloading library media ${i + 1}/${mediaUrls.length}: ${url.substring(0, 80)}...`);
            const response = await fetch(url);
            if (!response.ok) {
              console.warn(`⚠️ Failed to download: ${url} (${response.status})`);
              continue;
            }
            const buffer = Buffer.from(await response.arrayBuffer());
            const contentType = response.headers.get("content-type") || "image/jpeg";
            const type = mediaTypeFromMime(contentType);
            const fileId = `library-${i}-${uuidv4().substring(0, 8)}`;

            // Track mapping from generated fileId to real Supabase UUID
            if (i < mediaIds.length && mediaIds[i]) {
              libraryIdMap.set(fileId, mediaIds[i]);
            }

            if (type === "video") {
              try {
                const mp4DataUrl = convertVideoToMP4(buffer, contentType);
                const frames = extractVideoFramesFromBuffer(buffer, contentType, 10);
                if (frames.length > 0) {
                  videoMetadata.set(fileId, { originalId: fileId, frameCount: frames.length });
                  frames.forEach((frame, idx) => {
                    videoFrameItems.push({
                      id: `${fileId}-frame-${idx}`,
                      base64: frame,
                      type: "image",
                      mimeType: "image/jpeg",
                      videoId: fileId,
                      frameIndex: idx,
                      thumbnail: idx === 0 ? frames[0] : undefined,
                    });
                  });
                  convertedVideos.push({
                    id: fileId,
                    base64: mp4DataUrl,
                    type: "video",
                    mimeType: "video/mp4",
                  });
                }
              } catch (err: any) {
                console.error(`❌ Failed to process library video:`, err?.message || err);
              }
            } else {
              const dataUrl = bufferToDataUrl(buffer, contentType);
              directImages.push({
                id: fileId,
                base64: dataUrl,
                type: "image",
                mimeType: contentType,
              });
            }
          } catch (err: any) {
            console.error(`❌ Failed to download library media: ${url}`, err?.message || err);
          }
        }

        // Only send images + video frames to GPT (NOT the actual MP4 videos)
        const mediaForGPT = [...directImages, ...videoFrameItems];
        
        // All media for frontend (images + MP4 videos)
        const allMediaForFrontend = [...directImages, ...convertedVideos];
        
        // Count unique media items (images + videos, not frames)
        const uniqueMediaCount = directImages.length + videoMetadata.size;
        console.log(`📊 Media summary: ${directImages.length} images + ${videoMetadata.size} videos (${videoFrameItems.length} frames) = ${uniqueMediaCount} posts to generate`);
        console.log(`📤 Sending to GPT: ${directImages.length} images + ${videoFrameItems.length} video frames (${mediaForGPT.length} total items)`);
        console.log(`📦 Returning to frontend: ${directImages.length} images + ${convertedVideos.length} MP4 videos (${allMediaForFrontend.length} total items)`);

        if (mediaForGPT.length === 0) {
          res.status(400).json({
            error: "No processable media",
            message: "Could not process any of the provided media. Please try with images (JPEG/PNG) or shorter videos.",
          });
          return;
        }

        await handleGeneration(mediaForGPT, brandIdentity, res, videoMetadata, allMediaForFrontend, contentContext, libraryIdMap);
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
