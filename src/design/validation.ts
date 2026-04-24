const slugPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function assertValidSlug(value: string, label: string): void {
  if (!slugPattern.test(value)) {
    throw new Error(
      `Invalid ${label}: "${value}". Must match ^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$ (lowercase, hyphen-separated).`,
    );
  }
}

export function assertRequirement(
  requirementPath: string | undefined,
  requirementText: string | undefined,
): void {
  const hasPath = typeof requirementPath === "string" && requirementPath.trim().length > 0;
  const hasText = typeof requirementText === "string" && requirementText.trim().length > 0;
  if (hasPath === hasText) {
    throw new Error("Exactly one of --requirement-path or --requirement-text must be provided");
  }
}

export function isValidSlug(value: string): boolean {
  return slugPattern.test(value);
}
