import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import { generateRouter } from "./routes/generate";
import { brandRouter } from "./routes/brand";
import { authRouter } from "./routes/auth";
import { brandIdentityRouter } from "./routes/brand-identity";
import { mediaRouter } from "./routes/media";
import { foldersRouter } from "./routes/folders";
import { plansRouter } from "./routes/plans";
import { postsRouter } from "./routes/posts";

dotenv.config();

// Prevent EPIPE / socket errors from crashing the process.
// These happen when OpenAI drops the connection mid-upload (large payloads).
process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE" || err.code === "ECONNRESET" || err.code === "ERR_STREAM_WRITE_AFTER_END") {
    console.warn(`⚠️ Socket error caught (${err.code}): ${err.message} — server stays alive`);
    return; // swallow it, don't crash
  }
  // For anything else, log and keep running (don't exit)
  console.error("❌ Uncaught exception:", err);
});

process.on("unhandledRejection", (reason: unknown) => {
  console.error("❌ Unhandled promise rejection:", reason);
  // Don't crash — log and continue
});

const app = express();
const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

// Middleware
app.use(
  cors({
    origin: [FRONTEND_URL, "http://localhost:3000", "http://localhost:3001", "http://localhost:1010"],
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);
app.use(cookieParser());

// Increase payload limit for base64 images/videos (500MB to be safe)
app.use(express.json({ limit: "500mb" }));
app.use(express.urlencoded({ extended: true, limit: "500mb" }));

// Routes
app.use("/api/auth", authRouter);
app.use("/api/brand-identity", brandIdentityRouter);
app.use("/api/generate", generateRouter);
app.use("/api/brand", brandRouter);
app.use("/api/media", mediaRouter);
app.use("/api/folders", foldersRouter);
app.use("/api/plans", plansRouter);
app.use("/api/posts", postsRouter);

// Health check
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "1.0.0",
  });
});

// Global error handler — catches PayloadTooLargeError and other Express errors
app.use(
  (
    err: Error & { status?: number; type?: string },
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    if (err.type === "entity.too.large" || err.status === 413) {
      console.warn(`⚠️ Payload too large: ${err.message}`);
      res.status(413).json({
        error: "Payload too large",
        message:
          "De upload is te groot. Probeer minder of kleinere bestanden te uploaden. Maximum is 500MB per verzoek.",
      });
      return;
    }

    if (err.type === "entity.parse.failed" || err.status === 400) {
      console.warn(`⚠️ Bad request: ${err.message}`);
      res.status(400).json({
        error: "Invalid request",
        message: "Het verzoek kon niet worden verwerkt. Controleer de data en probeer opnieuw.",
      });
      return;
    }

    // Generic fallback
    console.error("❌ Unhandled error:", err);
    res.status(err.status || 500).json({
      error: "Server error",
      message: "Er is een onverwachte fout opgetreden. Probeer het opnieuw.",
    });
  }
);

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Postagen backend running on http://localhost:${PORT}`);
  console.log(`📡 CORS enabled for: ${FRONTEND_URL}`);
  console.log(`🔑 OpenAI API key: ${process.env.OPENAI_API_KEY ? "configured" : "MISSING"}`);
});

export default app;
