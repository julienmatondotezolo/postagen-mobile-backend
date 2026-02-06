import { Router, Request, Response } from "express";

export const brandRouter = Router();

// Pre-seeded brand data
const brands: Record<string, BrandData> = {
  "l-osteria": {
    businessName: "L'Osteria Deerlijk",
    websiteUrl: "https://l-osteria.be",
    description:
      "Familiaal Italiaans restaurant in Deerlijk, België. Gerund door Angelo en Jessica Bombini sinds 2003. De familiegeschiedenis gaat terug tot 1964 in Leuven (Gianni Bombini). Authentieke Italiaanse keuken met warme sfeer. Adres: Stationsstraat 232, 8540 Deerlijk.",
    tone: "warm, uitnodigend, familiegericht, mix van Nederlands en Italiaans",
    languages: ["nl", "fr", "it"],
    menuHighlights: [
      "Aperol Spritz (€12)",
      "Limoncello Spritz (€13)",
      "L'Osteria Cocktail (€12)",
      "Bruschetta tradizionale (€15)",
      "Carpaccio di manzo (€24.50)",
      "Caprese di Bufala (€20)",
      "Scampi flambé (€29)",
      "Salmone al prosecco (€35)",
      "Scampi L'Osteria (€45)",
      "Bistecca al naturale (€27.50)",
      "Filetto al naturale (€35)",
    ],
    openingHours: "Dinsdag tot zaterdag (gesloten op maandag en zondag)",
    phone: "+32 (0) 56 25 63 83",
    address: "Stationsstraat 232, 8540 Deerlijk",
  },
};

interface BrandData {
  businessName: string;
  websiteUrl: string;
  description: string;
  tone: string;
  languages: string[];
  menuHighlights: string[];
  openingHours?: string;
  phone?: string;
  address?: string;
}

// GET /api/brand/:slug
brandRouter.get("/:slug", (req: Request<{ slug: string }>, res: Response) => {
  const slug = req.params.slug;
  const brand = brands[slug];

  if (!brand) {
    res.status(404).json({
      error: "Brand not found",
      message: `No brand data found for slug: "${slug}"`,
      availableSlugs: Object.keys(brands),
    });
    return;
  }

  res.json(brand);
});

// GET /api/brand — list all available brands
brandRouter.get("/", (_req: Request, res: Response) => {
  const list = Object.entries(brands).map(([slug, data]) => ({
    slug,
    businessName: data.businessName,
    websiteUrl: data.websiteUrl,
  }));

  res.json({ brands: list });
});
