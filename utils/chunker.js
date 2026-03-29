export function chunkText(text, maxTokens = 12000) {
  const estimatedTokens = Math.ceil(text.length / 4);
  if (estimatedTokens <= maxTokens) {
    return [text];
  }

  const paragraphs = text.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const chunks = [];
  let currentChunk = "";
  let currentTokens = 0;

  for (const paragraph of paragraphs) {
    const paragraphTokens = Math.ceil(paragraph.length / 4);
    if (currentChunk && currentTokens + paragraphTokens > maxTokens) {
      chunks.push(currentChunk.trim());
      currentChunk = paragraph;
      currentTokens = paragraphTokens;
      continue;
    }

    currentChunk += `${currentChunk ? "\n\n" : ""}${paragraph}`;
    currentTokens += paragraphTokens;
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks.length > 0 ? chunks : [text];
}
