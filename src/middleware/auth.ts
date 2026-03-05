import { Request, Response, NextFunction } from "express";
import { supabase } from "../lib/supabase";

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    username: string | null;
    email_verified: boolean;
  };
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.cookies?.postagen_session;
  const route = `${req.method} ${req.originalUrl}`;

  if (!token) {
    console.warn(`🔒 AUTH FAIL [no token] ${route} — cookies: ${JSON.stringify(Object.keys(req.cookies || {}))}`);
    res.status(401).json({ error: "Niet ingelogd" });
    return;
  }

  const { data: session, error } = await supabase
    .from("sessions")
    .select("user_id, expires_at")
    .eq("token", token)
    .single();

  if (error || !session) {
    console.warn(`🔒 AUTH FAIL [invalid session] ${route} — token: ${token.slice(0, 8)}...`);
    res.clearCookie("postagen_session");
    res.status(401).json({ error: "Ongeldige sessie" });
    return;
  }

  if (new Date(session.expires_at) < new Date()) {
    console.warn(`🔒 AUTH FAIL [expired] ${route} — user_id: ${session.user_id}, expired: ${session.expires_at}`);
    await supabase.from("sessions").delete().eq("token", token);
    res.clearCookie("postagen_session");
    res.status(401).json({ error: "Sessie verlopen" });
    return;
  }

  const { data: user, error: userError } = await supabase
    .from("users")
    .select("id, email, username, email_verified")
    .eq("id", session.user_id)
    .single();

  if (userError || !user) {
    console.warn(`🔒 AUTH FAIL [user not found] ${route} — user_id: ${session.user_id}`);
    res.status(401).json({ error: "Gebruiker niet gevonden" });
    return;
  }

  req.user = user;
  next();
}
