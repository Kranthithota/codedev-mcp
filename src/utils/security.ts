import path from 'node:path';

/**
 * Validate that a path is safe to access within permissible roots.
 * Throws strict errors for violations.
 *
 * @param userPath - The input path from the user/agent (relative or absolute)
 * @param allowedRoots - Array of absolute paths permissible for access
 * @param cwd - Current working directory for resolving relative paths
 * @returns The normalized, validated absolute path.
 */
export function validatePath(userPath: string, allowedRoots: string[], cwd: string): string {
  // 1. Basic Input Validation
  if (userPath.includes('\0')) {
    throw new Error('Security Blocked: Path contains null bytes.');
  }

  // 2. Resolve absolute path
  const resolved = path.resolve(cwd, userPath);

  // 3. Normalize (resolves .. segments)
  const normalized = path.normalize(resolved);

  // 4. Verify containment
  // Check if the path starts with any of the allowed roots
  // Must compare with trailing separator to prevent /var/lib vs /var/lib-private partial matches
  // Exception: if the path IS the root itself.
  const isAllowed = allowedRoots.some((root) => {
    const relative = path.relative(root, normalized);

    // blocked: relative starts with '..' (outside root)
    // blocked: absolute path (different drive on windows, or just outside)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return false;
    }
    return true;
  });

  if (!isAllowed) {
    throw new Error(
      `Security Blocked: Path "${userPath}" resolves to "${normalized}", which is outside allowed roots: [${allowedRoots.join(', ')}]`,
    );
  }

  return normalized;
}

/**
 * Sanitize input to reject suspicious patterns immediately.
 * @param input - The input string to sanitize.
 * @returns The sanitized input string.
 */
export function sanitizeInput(input: string): string {
  if (input.includes('\0')) throw new Error('Input contains null bytes');
  return input;
}
