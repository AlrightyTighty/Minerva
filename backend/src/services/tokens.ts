/** chars / 4 is close enough for budgeting and thresholds. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
