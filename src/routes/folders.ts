import { Router, Response } from "express";
import { supabase } from "../lib/supabase";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();

// GET /api/folders — list user's folders with media count
router.get("/", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    const { data: folders, error } = await supabase
      .from("folders")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: true });

    if (error) {
      res.status(500).json({ error: "Failed to fetch folders" });
      return;
    }

    // Get media counts per folder
    const { data: mediaCounts, error: countError } = await supabase
      .from("media")
      .select("folder_id")
      .eq("user_id", userId)
      .not("folder_id", "is", null);

    if (countError) {
      // Return folders without counts on error
      res.json({ folders: folders.map((f) => ({ ...f, media_count: 0 })) });
      return;
    }

    const countMap = new Map<string, number>();
    for (const m of mediaCounts) {
      countMap.set(m.folder_id, (countMap.get(m.folder_id) || 0) + 1);
    }

    const foldersWithCount = folders.map((f) => ({
      ...f,
      media_count: countMap.get(f.id) || 0,
    }));

    res.json({ folders: foldersWithCount });
  } catch (error) {
    console.error("Folders list error:", error);
    res.status(500).json({ error: "Failed to fetch folders" });
  }
});

// POST /api/folders — create a folder
router.post("/", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { name, color } = req.body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      res.status(400).json({ error: "Folder name is required" });
      return;
    }

    const { data, error } = await supabase
      .from("folders")
      .insert({
        user_id: userId,
        name: name.trim(),
        color: color || "#8B5CF6",
      })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        res.status(409).json({ error: "A folder with this name already exists" });
        return;
      }
      res.status(500).json({ error: "Failed to create folder" });
      return;
    }

    res.status(201).json(data);
  } catch (error) {
    console.error("Folder create error:", error);
    res.status(500).json({ error: "Failed to create folder" });
  }
});

// PATCH /api/folders/:id — rename/recolor a folder
router.patch("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const { name, color } = req.body;

    const updates: Record<string, string> = { updated_at: new Date().toISOString() };
    if (name) updates.name = name.trim();
    if (color) updates.color = color;

    const { data, error } = await supabase
      .from("folders")
      .update(updates)
      .eq("id", id)
      .eq("user_id", userId)
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        res.status(409).json({ error: "A folder with this name already exists" });
        return;
      }
      res.status(404).json({ error: "Folder not found" });
      return;
    }

    res.json(data);
  } catch (error) {
    console.error("Folder update error:", error);
    res.status(500).json({ error: "Failed to update folder" });
  }
});

// DELETE /api/folders/:id — delete folder, move media to unsorted
router.delete("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    // Move media in this folder back to unsorted
    await supabase
      .from("media")
      .update({ folder: "unsorted", folder_id: null, updated_at: new Date().toISOString() })
      .eq("folder_id", id)
      .eq("user_id", userId);

    // Delete the folder
    const { error } = await supabase
      .from("folders")
      .delete()
      .eq("id", id)
      .eq("user_id", userId);

    if (error) {
      res.status(404).json({ error: "Folder not found" });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Folder delete error:", error);
    res.status(500).json({ error: "Failed to delete folder" });
  }
});

export { router as foldersRouter };
