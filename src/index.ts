import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { generateRouter } from "./routes/generate";
import { brandRouter } from "./routes/brand";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

// Middleware
app.use(
  cors({
    origin: [FRONTEND_URL, "http://localhost:3000", "http://localhost:3001"],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Increase payload limit for base64 images (150MB)
app.use(express.json({ limit: "150mb" }));
app.use(express.urlencoded({ extended: true, limit: "150mb" }));

// Routes
app.use("/api/generate", generateRouter);
app.use("/api/brand", brandRouter);

// Health check
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "1.0.0",
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Postagen backend running on http://localhost:${PORT}`);
  console.log(`📡 CORS enabled for: ${FRONTEND_URL}`);
  console.log(`🔑 OpenAI API key: ${process.env.OPENAI_API_KEY ? "configured" : "MISSING"}`);
});

export default app;
