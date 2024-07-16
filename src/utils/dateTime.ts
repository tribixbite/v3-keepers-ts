export function calculateDuration(start: number, end: number): string {
  const durationMs = end - start;
  const durationSeconds = (durationMs / 1000).toFixed(2);
  return durationSeconds + "s";
}

export const clockTime = () => new Date().toLocaleTimeString() + ": ";

export function pushNotify(message: string) {
  // Send message to Discord
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (webhookUrl === undefined) {
    throw new Error("Missing Discord webhook URL");
  }
  fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content: message }),
  });
}
