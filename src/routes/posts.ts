import { Router, Response } from "express";
import { supabase } from "../lib/supabase";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();

// GET /api/posts/:id — get single post with media
router.get("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const { data: post, error } = await supabase
      .from("posts")
      .select("*, media:media_id(id, url, type, filename)")
      .eq("id", id)
      .eq("user_id", userId)
      .single();

    if (error || !post) {
      res.status(404).json({ error: "Post not found" });
      return;
    }

    const media = post.media as { id: string; url: string; type: string; filename: string } | null;
    res.json({
      ...post,
      media_url: media?.url || null,
      media_type: media?.type || null,
      media: undefined,
    });
  } catch (error) {
    console.error("Post get error:", error);
    res.status(500).json({ error: "Failed to fetch post" });
  }
});

// PATCH /api/posts/:id — update post
router.patch("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const { caption, hashtags, scheduled_date, scheduled_time, day_name, sentiment, is_optimized, media_id, thumbnail } = req.body;

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (caption !== undefined) updates.caption = caption;
    if (hashtags !== undefined) updates.hashtags = hashtags;
    if (scheduled_date !== undefined) updates.scheduled_date = scheduled_date;
    if (scheduled_time !== undefined) updates.scheduled_time = scheduled_time;
    if (day_name !== undefined) updates.day_name = day_name;
    if (sentiment !== undefined) updates.sentiment = sentiment;
    if (is_optimized !== undefined) updates.is_optimized = is_optimized;
    if (media_id !== undefined) updates.media_id = media_id;
    if (thumbnail !== undefined) updates.thumbnail = thumbnail;

    const { data, error } = await supabase
      .from("posts")
      .update(updates)
      .eq("id", id)
      .eq("user_id", userId)
      .select()
      .single();

    if (error) {
      res.status(404).json({ error: "Post not found" });
      return;
    }

    res.json(data);
  } catch (error) {
    console.error("Post update error:", error);
    res.status(500).json({ error: "Failed to update post" });
  }
});

// DELETE /api/posts/:id — delete single post
router.delete("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const { error } = await supabase
      .from("posts")
      .delete()
      .eq("id", id)
      .eq("user_id", userId);

    if (error) {
      res.status(404).json({ error: "Post not found" });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Post delete error:", error);
    res.status(500).json({ error: "Failed to delete post" });
  }
});

export { router as postsRouter };
