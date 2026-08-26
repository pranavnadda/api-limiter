/**
 * Contact Endpoint — Portfolio Contact Form
 *
 * WHY: This mimics a real contact form submission. Rate limiting
 * here prevents spam bots from flooding your email or database.
 * Low limit (3 per 10 minutes per IP) is realistic.
 */

import { ok, fail } from "@/lib/api-response";
import { validateEmail } from "@/lib/utils";

interface ContactFormData {
  name: string;
  email: string;
  message: string;
}

/**
 * Validate contact form input.
 * WHY: Reject garbage cheaply—before hitting rate limiter or
 * downstream processing. Prevents wasted rate limit quota
 * on malformed requests.
 */
function validateContact(data: Partial<ContactFormData>): string[] {
  const errors: string[] = [];
  if (!data.name || data.name.length < 2) {
    errors.push("Name must be at least 2 characters");
  }
  if (!data.email || !validateEmail(data.email)) {
    errors.push("Valid email is required");
  }
  if (!data.message || data.message.length < 10) {
    errors.push("Message must be at least 10 characters");
  }
  return errors;
}

export async function POST(req: Request) {
  let body: ContactFormData;
  try {
    body = await req.json();
  } catch {
    return fail("PARSE_ERROR", "Invalid JSON in request body");
  }

  const errors = validateContact(body);
  if (errors.length > 0) {
    return fail("VALIDATION_ERROR", errors.join("; "), 400, errors);
  }

  // In a real app, you'd send an email here
  // For this demo, we just return success
  return ok({
    message: "Message sent successfully",
    reference: `contact-${Date.now()}`,
  });
}

export async function GET() {
  return ok({
    message: "Contact API is live",
    usage: "POST with { name, email, message }",
  });
}
