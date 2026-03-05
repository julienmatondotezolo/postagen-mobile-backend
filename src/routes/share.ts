import { Router, Request, Response } from "express";
import { supabase } from "../lib/supabase";
import { requireAuth, AuthRequest } from "../middleware/auth";
import crypto from "crypto";

const router = Router();

// POST /api/share/folder/:folderId — create or return existing share token (authenticated)
router.post("/folder/:folderId", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { folderId } = req.params;

    // Verify folder belongs to user
    const { data: folder, error: folderError } = await supabase
      .from("folders")
      .select("id")
      .eq("id", folderId)
      .eq("user_id", userId)
      .single();

    if (folderError || !folder) {
      res.status(404).json({ error: "Folder not found" });
      return;
    }

    // Check for existing share (active or inactive)
    const { data: existing } = await supabase
      .from("shared_folders")
      .select("*")
      .eq("folder_id", folderId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (existing) {
      // Reactivate if inactive
      if (!existing.is_active) {
        const { data: reactivated } = await supabase
          .from("shared_folders")
          .update({ is_active: true })
          .eq("id", existing.id)
          .select()
          .single();
        res.json(reactivated || existing);
        return;
      }
      res.json(existing);
      return;
    }

    // Create new share token
    const share_token = crypto.randomBytes(16).toString("hex");

    const { data, error } = await supabase
      .from("shared_folders")
      .insert({
        folder_id: folderId,
        user_id: userId,
        share_token,
      })
      .select()
      .single();

    if (error) {
      console.error("Share create error:", error);
      res.status(500).json({ error: "Failed to create share link" });
      return;
    }

    res.status(201).json(data);
  } catch (error) {
    console.error("Share folder error:", error);
    res.status(500).json({ error: "Failed to share folder" });
  }
});

// GET /api/share/folder/:folderId — get share status for a folder (authenticated)
router.get("/folder/:folderId", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { folderId } = req.params;

    const { data: shares } = await supabase
      .from("shared_folders")
      .select("share_token, is_active")
      .eq("folder_id", folderId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1);

    if (!shares || shares.length === 0) {
      res.status(404).json({ error: "No share found" });
      return;
    }

    res.json(shares[0]);
  } catch (error) {
    console.error("Get share status error:", error);
    res.status(500).json({ error: "Failed to get share status" });
  }
});

// PATCH /api/share/folder/:folderId — toggle is_active on share (authenticated)
router.patch("/folder/:folderId", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { folderId } = req.params;
    const { is_active } = req.body;

    if (typeof is_active !== "boolean") {
      res.status(400).json({ error: "is_active must be a boolean" });
      return;
    }

    // Find the most recent share for this folder
    const { data: existing } = await supabase
      .from("shared_folders")
      .select("id")
      .eq("folder_id", folderId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (!existing) {
      res.status(404).json({ error: "Share not found" });
      return;
    }

    const { data, error } = await supabase
      .from("shared_folders")
      .update({ is_active })
      .eq("id", existing.id)
      .select("share_token, is_active")
      .single();

    if (error || !data) {
      res.status(500).json({ error: "Failed to update share" });
      return;
    }

    res.json(data);
  } catch (error) {
    console.error("Toggle share error:", error);
    res.status(500).json({ error: "Failed to update share" });
  }
});

// GET /api/share/public/:token — get shared folder info + media (public)
router.get("/public/:token", async (req: Request, res: Response) => {
  try {
    const { token } = req.params;

    const { data: share, error: shareError } = await supabase
      .from("shared_folders")
      .select("*")
      .eq("share_token", token)
      .eq("is_active", true)
      .single();

    if (shareError || !share) {
      res.status(404).json({ error: "Share link not found or expired" });
      return;
    }

    // Get folder info
    const { data: folder } = await supabase
      .from("folders")
      .select("id, name, color")
      .eq("id", share.folder_id)
      .single();

    if (!folder) {
      res.status(404).json({ error: "Folder not found" });
      return;
    }

    // Get owner name
    const { data: owner } = await supabase
      .from("users")
      .select("username, email")
      .eq("id", share.user_id)
      .single();

    // Get all media in folder
    const { data: media } = await supabase
      .from("media")
      .select("id, url, type, filename, size, mime_type, status, created_at")
      .eq("folder_id", share.folder_id)
      .eq("user_id", share.user_id)
      .order("created_at", { ascending: false });

    res.json({
      folder,
      owner_name: owner?.username || owner?.email?.split("@")[0] || "Unknown",
      media: media || [],
      shared_folder_id: share.id,
    });
  } catch (error) {
    console.error("Public share error:", error);
    res.status(500).json({ error: "Failed to load shared folder" });
  }
});

// POST /api/share/public/:token/vote — submit a vote (public)
router.post("/public/:token/vote", async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const { voter_name, media_id, vote } = req.body;

    if (!voter_name || !media_id || !vote) {
      res.status(400).json({ error: "voter_name, media_id, and vote are required" });
      return;
    }

    if (!["liked", "unliked"].includes(vote)) {
      res.status(400).json({ error: "vote must be 'liked' or 'unliked'" });
      return;
    }

    // Verify token
    const { data: share } = await supabase
      .from("shared_folders")
      .select("id")
      .eq("share_token", token)
      .eq("is_active", true)
      .single();

    if (!share) {
      res.status(404).json({ error: "Share link not found or expired" });
      return;
    }

    // Upsert vote
    const { data, error } = await supabase
      .from("share_votes")
      .upsert(
        {
          shared_folder_id: share.id,
          media_id,
          voter_name: voter_name.trim(),
          vote,
        },
        { onConflict: "shared_folder_id,media_id,voter_name" }
      )
      .select()
      .single();

    if (error) {
      console.error("Vote error:", error);
      res.status(500).json({ error: "Failed to save vote" });
      return;
    }

    res.json(data);
  } catch (error) {
    console.error("Vote error:", error);
    res.status(500).json({ error: "Failed to save vote" });
  }
});

// GET /api/share/public/:token/votes/:voterName — get voter's existing votes (public)
router.get("/public/:token/votes/:voterName", async (req: Request, res: Response) => {
  try {
    const { token, voterName } = req.params;

    const { data: share } = await supabase
      .from("shared_folders")
      .select("id")
      .eq("share_token", token)
      .eq("is_active", true)
      .single();

    if (!share) {
      res.status(404).json({ error: "Share link not found or expired" });
      return;
    }

    const { data: votes } = await supabase
      .from("share_votes")
      .select("media_id, vote, created_at")
      .eq("shared_folder_id", share.id)
      .eq("voter_name", voterName);

    res.json({ votes: votes || [] });
  } catch (error) {
    console.error("Get votes error:", error);
    res.status(500).json({ error: "Failed to get votes" });
  }
});

export { router as shareRouter };
