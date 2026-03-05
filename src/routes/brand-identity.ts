import { Router } from "express";
import { supabase } from "../lib/supabase";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();

// GET /api/brand-identity — get current user's brand identity
router.get("/", requireAuth as any, async (req: AuthRequest, res) => {
  try {
    const { data, error } = await supabase
      .from("brand_identities")
      .select("id, business_name, website_url, description, analyzed_at")
      .eq("user_id", req.user!.id)
      .single();

    if (error || !data) {
      res.json({ brandIdentity: null });
      return;
    }

    res.json({
      brandIdentity: {
        id: data.id,
        businessName: data.business_name,
        websiteUrl: data.website_url,
        description: data.description,
        analyzedAt: data.analyzed_at,
      },
    });
  } catch (err) {
    console.error("Get brand identity error:", err);
    res.status(500).json({ error: "Kon merkidentiteit niet ophalen" });
  }
});

// POST /api/brand-identity — create or update brand identity
router.post("/", requireAuth as any, async (req: AuthRequest, res) => {
  try {
    const { businessName, websiteUrl, description } = req.body;
    const userId = req.user!.id;

    const { data: existing } = await supabase
      .from("brand_identities")
      .select("id")
      .eq("user_id", userId)
      .single();

    if (existing) {
      const { data, error } = await supabase
        .from("brand_identities")
        .update({
          business_name: businessName || null,
          website_url: websiteUrl || null,
          description: description || null,
          analyzed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId)
        .select("id, business_name, website_url, description, analyzed_at")
        .single();

      if (error) {
        console.error("Update brand identity error:", error);
        res.status(500).json({ error: "Kon merkidentiteit niet bijwerken" });
        return;
      }

      res.json({
        brandIdentity: {
          id: data.id,
          businessName: data.business_name,
          websiteUrl: data.website_url,
          description: data.description,
          analyzedAt: data.analyzed_at,
        },
      });
    } else {
      const { data, error } = await supabase
        .from("brand_identities")
        .insert({
          user_id: userId,
          business_name: businessName || null,
          website_url: websiteUrl || null,
          description: description || null,
          analyzed_at: new Date().toISOString(),
        })
        .select("id, business_name, website_url, description, analyzed_at")
        .single();

      if (error) {
        console.error("Create brand identity error:", error);
        res.status(500).json({ error: "Kon merkidentiteit niet opslaan" });
        return;
      }

      res.status(201).json({
        brandIdentity: {
          id: data.id,
          businessName: data.business_name,
          websiteUrl: data.website_url,
          description: data.description,
          analyzedAt: data.analyzed_at,
        },
      });
    }
  } catch (err) {
    console.error("Brand identity error:", err);
    res.status(500).json({ error: "Er is een fout opgetreden" });
  }
});

export { router as brandIdentityRouter };
