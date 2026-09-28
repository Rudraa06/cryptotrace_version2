import { logger } from '../lib/logger.js';

/**
 * Sends a transactional email using Brevo (Sendinblue) V3 REST API.
 * 
 * @param {string} to - Recipient email address
 * @param {string} subject - Email subject
 * @param {string} htmlContent - HTML body of the email
 */
async function sendBrevoEmail(to, subject, htmlContent) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL || 'noreply@cryptotrace.gov';
  const senderName = process.env.BREVO_SENDER_NAME || 'CryptoTrace Security';

  if (!apiKey) {
    logger.warn('BREVO_API_KEY is not configured. Email will be logged to console instead of sent.');
    logger.info(`[MOCK EMAIL to ${to}] Subject: ${subject}\n\n${htmlContent}`);
    return;
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'api-key': apiKey
      },
      body: JSON.stringify({
        sender: { name: senderName, email: senderEmail },
        to: [{ email: to }],
        subject: subject,
        htmlContent: htmlContent
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Brevo API Error (${response.status}): ${JSON.stringify(errorData)}`);
    }

    logger.info('Transactional email sent successfully', { to, subject });
  } catch (error) {
    logger.error('Failed to send transactional email', { error: error.message, to });
    throw error;
  }
}

/**
 * Sends an account activation email with a setup link.
 */
export async function sendActivationEmail(email, token, name) {
  // Use frontend URL from env, default to production vercel if not set
  const baseUrl = process.env.FRONTEND_URL || 'https://cryptotrace-version2.vercel.app';
  const activationLink = `${baseUrl}/activate?token=${token}`;

  const html = `
    <div style="font-family: sans-serif; max-w-xl; margin: 0 auto; color: #333;">
      <h2 style="color: #6d28d9;">CryptoTrace Account Activation</h2>
      <p>Hello ${name},</p>
      <p>An administrator has created a CryptoTrace investigator account for you.</p>
      <p>Please click the button below to activate your account and set a secure password. This link will expire in 24 hours.</p>
      <div style="margin: 30px 0;">
        <a href="${activationLink}" style="background-color: #6d28d9; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">Activate Account</a>
      </div>
      <p style="font-size: 12px; color: #666;">If the button doesn't work, copy and paste this link into your browser:</p>
      <p style="font-size: 12px; word-break: break-all;">${activationLink}</p>
    </div>
  `;

  await sendBrevoEmail(email, 'Activate Your CryptoTrace Account', html);
}

/**
 * Sends a password reset email.
 */
export async function sendPasswordResetEmail(email, token) {
  const baseUrl = process.env.FRONTEND_URL || 'https://cryptotrace-version2.vercel.app';
  const resetLink = `${baseUrl}/reset-password?token=${token}`;

  const html = `
    <div style="font-family: sans-serif; max-w-xl; margin: 0 auto; color: #333;">
      <h2 style="color: #6d28d9;">CryptoTrace Password Reset</h2>
      <p>We received a request to reset the password for your CryptoTrace account.</p>
      <p>Click the button below to choose a new password. This link will expire in 1 hour.</p>
      <div style="margin: 30px 0;">
        <a href="${resetLink}" style="background-color: #6d28d9; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">Reset Password</a>
      </div>
      <p style="font-size: 12px; color: #666;">If you did not request this, you can safely ignore this email.</p>
    </div>
  `;

  await sendBrevoEmail(email, 'CryptoTrace Password Reset', html);
}
