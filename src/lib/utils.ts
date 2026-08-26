/**
 * Utility Functions
 *
 * WHY: Small, pure helper functions that don't need a dedicated module.
 */

/**
 * Validate email format using a basic regex.
 *
 * WHY: Not RFC-compliant (that's overkill for a portfolio form), but
 * catches obvious typos and bot submissions.
 */
export function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}
