// src/services/email.service.js
const FRONTEND = process.env.FRONTEND_URL || 'https://weka-soko-nextjs-q89r3s4q6.vercel.app';

async function sendEmail(to, name, subject, text) {
  // Check for Brevo configuration
  const brevoKey = process.env.BREVO_API_KEY;
  const fromEmail = process.env.EMAIL_FROM;
  
  if (!brevoKey || !fromEmail) {
    console.log(`[Email] Skipped (not configured): ${subject} to ${to}`);
    console.log(`[Email] BREVO_API_KEY: ${brevoKey ? 'SET' : 'MISSING'}`);
    console.log(`[Email] EMAIL_FROM: ${fromEmail ? 'SET' : 'MISSING'}`);
    return;
  }

  try {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${subject}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800&display=swap');
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #F4F4F4; font-family: 'Outfit', Arial, sans-serif; color: #1D1D1D; -webkit-font-smoothing: antialiased; }
a { color: #1428A0; text-decoration: none; }
a:hover { text-decoration: underline; }
</style>
</head>
<body style="background:#F4F4F4;padding:40px 16px;">

<!-- Wrapper -->
<table width="100%" cellpadding="0" cellspacing="0" role="presentation">
<tr>
<td align="center">
<table width="100%" style="max-width:600px;" cellpadding="0" cellspacing="0" role="presentation">

<!-- Header / Nav bar -->
<tr>
<td style="background:#000000;padding:20px 32px;">
<table width="100%" cellpadding="0" cellspacing="0" role="presentation">
<tr>
<td>
<span style="font-family:'Outfit',Arial,sans-serif;font-size:20px;font-weight:800;color:#FFFFFF;letter-spacing:-0.01em;">
Weka<span style="color:#4B77FF;">Soko</span>
</span>
</td>
<td align="right">
<span style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.5);">
Kenya's Resell Platform
</span>
</td>
</tr>
</table>
</td>
</tr>

<!-- Blue accent bar -->
<tr>
<td style="background:#1428A0;height:3px;"></td>
</tr>

<!-- Main content card -->
<tr>
<td style="background:#FFFFFF;padding:40px 32px;">

<!-- Subject line as heading -->
<p style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#1428A0;margin-bottom:12px;">
Message from Weka Soko
</p>
<h1 style="font-family:'Outfit',Arial,sans-serif;font-size:24px;font-weight:800;color:#1D1D1D;letter-spacing:-0.02em;margin-bottom:24px;line-height:1.2;">
${subject}
</h1>

<!-- Divider -->
<div style="height:1px;background:#E0E0E0;margin-bottom:28px;"></div>

<!-- Body text -->
<div style="font-size:15px;line-height:1.85;color:#535353;white-space:pre-wrap;">
${text.replace(/</g, "&lt;").replace(/>/g, "&gt;")}
</div>

<!-- CTA area -->
<div style="margin-top:36px;padding-top:28px;border-top:1px solid #E0E0E0;">
<a href="${FRONTEND}"
style="display:inline-block;background:#1428A0;color:#FFFFFF;font-family:'Outfit',Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:0.02em;padding:12px 28px;text-decoration:none;">
Visit Weka Soko →
</a>
</div>

</td>
</tr>

<!-- Footer -->
<tr>
<td style="background:#F4F4F4;padding:24px 32px;border-top:1px solid #E0E0E0;">
<table width="100%" cellpadding="0" cellspacing="0" role="presentation">
<tr>
<td>
<p style="font-size:11px;color:#767676;line-height:1.7;margin:0;">
<strong style="color:#1D1D1D;">Weka Soko</strong> · Kenya's Smartest Resell Platform<br>
This is a transactional email sent to ${to}<br>
<a href="mailto:${fromEmail}?subject=Unsubscribe" style="color:#767676;">Unsubscribe</a>
&nbsp;·&nbsp;
<a href="mailto:support@wekasoko.co.ke" style="color:#767676;">Support</a>
&nbsp;·&nbsp;
<a href="${FRONTEND}" style="color:#767676;">wekasoko.co.ke</a>
</p>
</td>
<td align="right" style="vertical-align:top;">
<span style="font-size:18px;font-weight:800;color:#1D1D1D;font-family:'Outfit',Arial,sans-serif;letter-spacing:-0.01em;">
Weka<span style="color:#1428A0;">Soko</span>
</span>
</td>
</tr>
</table>
</td>
</tr>

<!-- Bottom accent bar -->
<tr>
<td style="background:#1428A0;height:2px;"></td>
</tr>

</table>
</td>
</tr>
</table>

</body>
</html>`;

    // Brevo API format
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { 
        "api-key": brevoKey,
        "Content-Type": "application/json" 
      },
      body: JSON.stringify({
        sender: { email: fromEmail, name: "Weka Soko" },
        to: [{ email: to, name: name || to }],
        replyTo: { email: fromEmail, name: "Weka Soko" },
        subject: subject,
        htmlContent: html,
        textContent: text,
        tags: ["transactional"]
      }),
    });

    if (!res.ok) {
      const e = await res.text();
      console.error("[Email] Brevo error:", res.status, e);
      // Don't throw - just log error (original behavior)
      return;
    }

    console.log(`[Email] Sent to ${to} — "${subject}"`);
  } catch (err) {
    console.error("[Email] failed:", err.message);
    // Don't throw - just log error (original behavior)
  }
}

module.exports = { sendEmail };
