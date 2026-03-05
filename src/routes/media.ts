import { Router, Response } from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { supabase } from "../lib/supabase";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

// POST /api/media/upload — upload files to Supabase Storage + insert DB rows
router.post(
  "/upload",
  requireAuth,
  upload.array("files", 50),
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const files = req.files as Express.Multer.File[];
      const folderId = req.body?.folderId as string | undefined;

      if (!files || files.length === 0) {
        res.status(400).json({ error: "No files provided" });
        return;
      }

      const records = [];

      for (const file of files) {
        const ext = file.originalname.split(".").pop()?.toLowerCase() || "jpg";
        const fileId = uuidv4();
        const storagePath = `${userId}/${fileId}.${ext}`;

        // Upload to Supabase Storage
        const { error: uploadError } = await supabase.storage
          .from("media")
          .upload(storagePath, file.buffer, {
            contentType: file.mimetype,
            upsert: false,
          });

        if (uploadError) {
          console.error(`Upload error for ${file.originalname}:`, uploadError);
          continue;
        }

        // Get public URL
        const { data: urlData } = supabase.storage
          .from("media")
          .getPublicUrl(storagePath);

        const type = file.mimetype.startsWith("video/") ? "video" : "image";

        // Insert DB row
        const { data: row, error: dbError } = await supabase
          .from("media")
          .insert({
            id: fileId,
            user_id: userId,
            url: urlData.publicUrl,
            storage_path: storagePath,
            type,
            filename: file.originalname,
            size: file.size,
            mime_type: file.mimetype,
            folder: folderId ? "custom" : "unsorted",
            ...(folderId ? { folder_id: folderId } : {}),
          })
          .select()
          .single();

        if (dbError) {
          console.error(`DB error for ${file.originalname}:`, dbError);
          // Clean up storage on DB failure
          await supabase.storage.from("media").remove([storagePath]);
          continue;
        }

        records.push(row);
      }

      res.json({ media: records, count: records.length });
    } catch (error) {
      console.error("Media upload error:", error);
      res.status(500).json({ error: "Upload failed" });
    }
  }
);

// POST /api/media/bulk-delete — delete multiple media items
router.post(
  "/bulk-delete",
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const { ids } = req.body;

      if (!Array.isArray(ids) || ids.length === 0) {
        res.status(400).json({ error: "No IDs provided" });
        return;
      }

      if (ids.length > 100) {
        res.status(400).json({ error: "Maximum 100 items per request" });
        return;
      }

      // Fetch storage paths for all items
      const { data: mediaItems, error: fetchError } = await supabase
        .from("media")
        .select("id, storage_path")
        .in("id", ids)
        .eq("user_id", userId);

      if (fetchError || !mediaItems || mediaItems.length === 0) {
        res.status(404).json({ error: "No media found" });
        return;
      }

      // Delete from storage
      const storagePaths = mediaItems.map((m) => m.storage_path);
      await supabase.storage.from("media").remove(storagePaths);

      // Delete from DB
      const mediaIds = mediaItems.map((m) => m.id);
      const { error: deleteError } = await supabase
        .from("media")
        .delete()
        .in("id", mediaIds)
        .eq("user_id", userId);

      if (deleteError) {
        res.status(500).json({ error: "Failed to delete media" });
        return;
      }

      res.json({ success: true, deleted: mediaIds.length });
    } catch (error) {
      console.error("Bulk delete error:", error);
      res.status(500).json({ error: "Failed to delete media" });
    }
  }
);

// GET /api/media — list media with optional folder filter
router.get("/", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { folder, folderId, limit = "50", offset = "0" } = req.query;

    let query = supabase
      .from("media")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (folderId && typeof folderId === "string") {
      query = query.eq("folder_id", folderId);
    } else if (folder && folder !== "all") {
      query = query.eq("folder", folder);
    }

    const { data, error } = await query;

    if (error) {
      res.status(500).json({ error: "Failed to fetch media" });
      return;
    }

    res.json({ media: data });
  } catch (error) {
    console.error("Media list error:", error);
    res.status(500).json({ error: "Failed to fetch media" });
  }
});

// GET /api/media/stats — media counts by folder
router.get("/stats", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    const { data, error } = await supabase
      .from("media")
      .select("folder, folder_id")
      .eq("user_id", userId);

    if (error) {
      res.status(500).json({ error: "Failed to fetch stats" });
      return;
    }

    const customFolderCounts: Record<string, number> = {};
    for (const m of data) {
      if (m.folder_id) {
        customFolderCounts[m.folder_id] = (customFolderCounts[m.folder_id] || 0) + 1;
      }
    }

    const stats = {
      total: data.length,
      unsorted: data.filter((m) => m.folder === "unsorted").length,
      liked: data.filter((m) => m.folder === "liked").length,
      unliked: data.filter((m) => m.folder === "unliked").length,
      customFolders: customFolderCounts,
    };

    res.json(stats);
  } catch (error) {
    console.error("Media stats error:", error);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// PATCH /api/media/:id/folder — update media folder
router.patch(
  "/:id/folder",
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const { id } = req.params;
      const { folder, folderId } = req.body;

      const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };

      if (folderId) {
        // Move to custom folder
        updateData.folder = "custom";
        updateData.folder_id = folderId;
      } else if (folder && ["liked", "unliked", "unsorted"].includes(folder)) {
        // Move to system folder
        updateData.folder = folder;
        updateData.folder_id = null;
      } else {
        res.status(400).json({ error: "Invalid folder" });
        return;
      }

      const { data, error } = await supabase
        .from("media")
        .update(updateData)
        .eq("id", id)
        .eq("user_id", userId)
        .select()
        .single();

      if (error) {
        res.status(404).json({ error: "Media not found" });
        return;
      }

      res.json(data);
    } catch (error) {
      console.error("Media folder update error:", error);
      res.status(500).json({ error: "Failed to update folder" });
    }
  }
);

// DELETE /api/media/:id — delete from Storage + DB
router.delete(
  "/:id",
  requireAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const { id } = req.params;

      // Get storage path first
      const { data: media, error: fetchError } = await supabase
        .from("media")
        .select("storage_path")
        .eq("id", id)
        .eq("user_id", userId)
        .single();

      if (fetchError || !media) {
        res.status(404).json({ error: "Media not found" });
        return;
      }

      // Delete from storage
      await supabase.storage.from("media").remove([media.storage_path]);

      // Delete from DB
      const { error: deleteError } = await supabase
        .from("media")
        .delete()
        .eq("id", id)
        .eq("user_id", userId);

      if (deleteError) {
        res.status(500).json({ error: "Failed to delete media" });
        return;
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Media delete error:", error);
      res.status(500).json({ error: "Failed to delete media" });
    }
  }
);

export { router as mediaRouter };
