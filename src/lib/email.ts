import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:1010";

export async function sendVerificationEmail(email: string, token: string, name?: string) {
  const verifyUrl = `${FRONTEND_URL.replace("http://localhost:1010", "http://localhost:3001")}/api/auth/verify-email?token=${token}`;

  const { error } = await resend.emails.send({
    from: "Postagen <onboarding@resend.dev>",
    to: email,
    subject: "Verifieer je e-mailadres - Postagen",
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <div style="text-align: center; margin-bottom: 32px;">
          <h1 style="color: #8B5CF6; font-size: 28px; margin: 0;">Postagen</h1>
        </div>
        <div style="background: #ffffff; border-radius: 16px; padding: 32px; border: 1px solid #f3f4f6;">
          <h2 style="color: #111827; font-size: 20px; margin: 0 0 16px;">Welkom${name ? `, ${name}` : ""}!</h2>
          <p style="color: #6b7280; font-size: 15px; line-height: 1.6; margin: 0 0 24px;">
            Bedankt voor je registratie bij Postagen. Klik op de knop hieronder om je e-mailadres te verifi&euml;ren.
          </p>
          <div style="text-align: center; margin: 32px 0;">
            <a href="${verifyUrl}" style="background: #8B5CF6; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 12px; font-weight: 600; font-size: 15px; display: inline-block;">
              Verifieer e-mailadres
            </a>
          </div>
          <p style="color: #9ca3af; font-size: 13px; line-height: 1.5; margin: 0;">
            Deze link is 24 uur geldig. Als je geen account hebt aangemaakt, kun je deze e-mail negeren.
          </p>
        </div>
      </div>
    `,
  });

  if (error) {
    console.error("Failed to send verification email:", error);
    throw new Error("Could not send verification email");
  }
}
