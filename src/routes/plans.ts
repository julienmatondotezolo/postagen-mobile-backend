import { Router, Response } from "express";
import { supabase } from "../lib/supabase";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();

// GET /api/plans — list all plans
router.get("/", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    const { data, error } = await supabase
      .from("plans")
      .select("*, posts(count)")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) {
      res.status(500).json({ error: "Failed to fetch plans" });
      return;
    }

    const plans = data.map((p) => ({
      ...p,
      post_count: p.posts?.[0]?.count ?? 0,
      posts: undefined,
    }));

    res.json({ plans });
  } catch (error) {
    console.error("Plans list error:", error);
    res.status(500).json({ error: "Failed to fetch plans" });
  }
});

// GET /api/plans/:id — get plan with posts (+ media URLs)
router.get("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const { data: plan, error: planError } = await supabase
      .from("plans")
      .select("*")
      .eq("id", id)
      .eq("user_id", userId)
      .single();

    if (planError || !plan) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }

    const { data: posts, error: postsError } = await supabase
      .from("posts")
      .select("*, media:media_id(id, url, type, filename, storage_path)")
      .eq("plan_id", id)
      .eq("user_id", userId)
      .order("scheduled_date", { ascending: true });

    if (postsError) {
      res.status(500).json({ error: "Failed to fetch posts" });
      return;
    }

    // Flatten media info
    const postsWithMedia = posts.map((p) => {
      const media = p.media as { id: string; url: string; type: string; filename: string; storage_path: string } | null;
      return {
        ...p,
        media_url: media?.url || null,
        media_type: media?.type || null,
        media: undefined,
      };
    });

    res.json({ plan, posts: postsWithMedia });
  } catch (error) {
    console.error("Plan detail error:", error);
    res.status(500).json({ error: "Failed to fetch plan" });
  }
});

// POST /api/plans — create plan with nested posts
router.post("/", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { name, description, status, posts } = req.body;

    if (!name) {
      res.status(400).json({ error: "Plan name is required" });
      return;
    }

    // Deactivate other plans
    await supabase
      .from("plans")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("is_active", true);

    // Create plan
    const { data: plan, error: planError } = await supabase
      .from("plans")
      .insert({
        user_id: userId,
        name,
        description: description || null,
        status: status || "Draft",
        is_active: true,
      })
      .select()
      .single();

    if (planError || !plan) {
      console.error("Plan create error:", planError);
      res.status(500).json({ error: "Failed to create plan" });
      return;
    }

    // Create posts if provided
    let createdPosts: unknown[] = [];
    if (Array.isArray(posts) && posts.length > 0) {
      const postRows = posts.map((p: Record<string, unknown>) => ({
        user_id: userId,
        plan_id: plan.id,
        media_id: p.media_id || null,
        caption: p.caption || "",
        hashtags: p.hashtags || [],
        post_type: p.post_type || "feed",
        platform_tip: p.platform_tip || "",
        scheduled_date: p.scheduled_date || null,
        scheduled_time: p.scheduled_time || null,
        day_name: p.day_name || null,
        sentiment: p.sentiment || "Neutral",
        is_optimized: p.is_optimized || false,
        thumbnail: p.thumbnail || null,
      }));

      const { data: postData, error: postsError } = await supabase
        .from("posts")
        .insert(postRows)
        .select();

      if (postsError) {
        console.error("Posts create error:", postsError);
      } else {
        createdPosts = postData || [];
      }
    }

    res.status(201).json({ plan, posts: createdPosts });
  } catch (error) {
    console.error("Plan create error:", error);
    res.status(500).json({ error: "Failed to create plan" });
  }
});

// PATCH /api/plans/:id — update plan
router.patch("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const { name, description, status, is_active } = req.body;

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (status !== undefined) updates.status = status;
    if (is_active !== undefined) updates.is_active = is_active;

    const { data, error } = await supabase
      .from("plans")
      .update(updates)
      .eq("id", id)
      .eq("user_id", userId)
      .select()
      .single();

    if (error) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }

    res.json(data);
  } catch (error) {
    console.error("Plan update error:", error);
    res.status(500).json({ error: "Failed to update plan" });
  }
});

// DELETE /api/plans/:id — cascade deletes posts
router.delete("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const { error } = await supabase
      .from("plans")
      .delete()
      .eq("id", id)
      .eq("user_id", userId);

    if (error) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Plan delete error:", error);
    res.status(500).json({ error: "Failed to delete plan" });
  }
});

export { router as plansRouter };
