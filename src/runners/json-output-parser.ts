const MAX_CANDIDATES = 16;

export function extractJsonCandidates(text: string): string[] {
  const results: string[] = [];
  const fencePattern = /```(?:json)?\s*\n?([\s\S]*?)\n?```/g;
  for (const match of text.matchAll(fencePattern)) {
    const block = match[1]?.trim();
    if (block) results.push(block);
    if (results.length >= MAX_CANDIDATES) return results;
  }

  for (const block of balancedBraceBlocks(text)) {
    results.push(block);
    if (results.length >= MAX_CANDIDATES) break;
  }

  return results;
}

export function recoverTruncatedJson(text: string): string | null {
  const stack: Array<"{" | "["> = [];
  let outerStart = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      if (stack.length === 0 && char === "{") outerStart = i;
      stack.push(char);
      continue;
    }
    if (char === "}" || char === "]") {
      if (stack.length === 0) continue;
      stack.pop();
      if (stack.length === 0) outerStart = -1;
    }
  }

  if (inString) return null;
  if (outerStart < 0 || stack.length === 0) return null;

  const body = text.slice(outerStart).replace(/[\s,]+$/, "");
  const closes = stack
    .slice()
    .reverse()
    .map((open) => (open === "{" ? "}" : "]"))
    .join("");
  return body + closes;
}

function balancedBraceBlocks(text: string): string[] {
  const blocks: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (char === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        blocks.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return blocks;
}
