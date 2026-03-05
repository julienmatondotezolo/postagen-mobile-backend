import { Router, Response } from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { supabase } from "../lib/supabase";
import { sendVerificationEmail } from "../lib/email";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:1010";
const IS_PRODUCTION = process.env.NODE_ENV === "production";

function setSessionCookie(res: Response, token: string) {
  res.cookie("postagen_session", token, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: IS_PRODUCTION ? "none" : "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    path: "/",
  });
}

// POST /api/auth/register
router.post("/register", async (req, res) => {
  try {
    const { email, password, username } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: "E-mail en wachtwoord zijn verplicht" });
      return;
    }

    if (password.length < 8) {
      res.status(400).json({ error: "Wachtwoord moet minimaal 8 tekens bevatten" });
      return;
    }

    // Check if user exists
    const { data: existing } = await supabase
      .from("users")
      .select("id")
      .eq("email", email.toLowerCase())
      .single();

    if (existing) {
      res.status(409).json({ error: "Er bestaat al een account met dit e-mailadres" });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const verificationToken = crypto.randomBytes(32).toString("hex");
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    const { data: user, error } = await supabase
      .from("users")
      .insert({
        email: email.toLowerCase(),
        password_hash: passwordHash,
        username: username || null,
        email_verification_token: verificationToken,
        email_verification_expires_at: verificationExpires.toISOString(),
      })
      .select("id, email, username, email_verified")
      .single();

    if (error) {
      console.error("Registration error:", error);
      res.status(500).json({ error: "Registratie mislukt" });
      return;
    }

    // Send verification email (non-blocking)
    sendVerificationEmail(email.toLowerCase(), verificationToken, username).catch((err) =>
      console.error("Failed to send verification email:", err)
    );

    // Create session
    const sessionToken = crypto.randomBytes(48).toString("hex");
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await supabase.from("sessions").insert({
      user_id: user.id,
      token: sessionToken,
      expires_at: expiresAt.toISOString(),
      ip_address: req.ip,
      user_agent: req.headers["user-agent"] || null,
    });

    setSessionCookie(res, sessionToken);
    res.status(201).json({ user, token: sessionToken });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Er is een fout opgetreden" });
  }
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: "E-mail en wachtwoord zijn verplicht" });
      return;
    }

    const { data: user, error } = await supabase
      .from("users")
      .select("id, email, username, email_verified, password_hash")
      .eq("email", email.toLowerCase())
      .single();

    if (error || !user) {
      res.status(401).json({ error: "Ongeldige inloggegevens" });
      return;
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      res.status(401).json({ error: "Ongeldige inloggegevens" });
      return;
    }

    // Create session
    const sessionToken = crypto.randomBytes(48).toString("hex");
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await supabase.from("sessions").insert({
      user_id: user.id,
      token: sessionToken,
      expires_at: expiresAt.toISOString(),
      ip_address: req.ip,
      user_agent: req.headers["user-agent"] || null,
    });

    setSessionCookie(res, sessionToken);

    const { password_hash: _, ...safeUser } = user;
    res.json({ user: safeUser, token: sessionToken });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Er is een fout opgetreden" });
  }
});

// POST /api/auth/logout
router.post("/logout", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "") || req.cookies?.postagen_session;

  if (token) {
    await supabase.from("sessions").delete().eq("token", token);
  }

  res.clearCookie("postagen_session", { path: "/" });
  res.json({ success: true });
});

// GET /api/auth/me
router.get("/me", requireAuth as any, (req: AuthRequest, res) => {
  res.json({ user: req.user });
});

// GET /api/auth/verify-email
router.get("/verify-email", async (req, res) => {
  const { token } = req.query;

  if (!token || typeof token !== "string") {
    res.redirect(`${FRONTEND_URL}/auth/verify-email?status=error`);
    return;
  }

  const { data: user, error } = await supabase
    .from("users")
    .select("id, email_verification_expires_at")
    .eq("email_verification_token", token)
    .single();

  if (error || !user) {
    res.redirect(`${FRONTEND_URL}/auth/verify-email?status=invalid`);
    return;
  }

  if (new Date(user.email_verification_expires_at) < new Date()) {
    res.redirect(`${FRONTEND_URL}/auth/verify-email?status=expired`);
    return;
  }

  await supabase
    .from("users")
    .update({
      email_verified: true,
      email_verification_token: null,
      email_verification_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", user.id);

  res.redirect(`${FRONTEND_URL}/auth/verify-email?status=success`);
});

// POST /api/auth/resend-verification
router.post("/resend-verification", requireAuth as any, async (req: AuthRequest, res) => {
  try {
    const user = req.user!;

    if (user.email_verified) {
      res.status(400).json({ error: "E-mail is al geverifieerd" });
      return;
    }

    const verificationToken = crypto.randomBytes(32).toString("hex");
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await supabase
      .from("users")
      .update({
        email_verification_token: verificationToken,
        email_verification_expires_at: verificationExpires.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", user.id);

    await sendVerificationEmail(user.email, verificationToken, user.username || undefined);

    res.json({ success: true });
  } catch (err) {
    console.error("Resend verification error:", err);
    res.status(500).json({ error: "Kon verificatie-e-mail niet opnieuw versturen" });
  }
});

// POST /api/auth/change-password
router.post("/change-password", requireAuth as any, async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      res.status(400).json({ error: "Current and new password are required" });
      return;
    }

    if (newPassword.length < 8) {
      res.status(400).json({ error: "New password must be at least 8 characters" });
      return;
    }

    // Fetch password hash
    const { data: userData, error: fetchError } = await supabase
      .from("users")
      .select("password_hash")
      .eq("id", user.id)
      .single();

    if (fetchError || !userData) {
      res.status(500).json({ error: "Could not verify user" });
      return;
    }

    const validPassword = await bcrypt.compare(currentPassword, userData.password_hash);
    if (!validPassword) {
      res.status(401).json({ error: "Current password is incorrect" });
      return;
    }

    const newHash = await bcrypt.hash(newPassword, 12);

    const { error: updateError } = await supabase
      .from("users")
      .update({ password_hash: newHash, updated_at: new Date().toISOString() })
      .eq("id", user.id);

    if (updateError) {
      res.status(500).json({ error: "Could not update password" });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Change password error:", err);
    res.status(500).json({ error: "An error occurred" });
  }
});

export { router as authRouter };
