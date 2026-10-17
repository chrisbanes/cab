/** The app's clock label, local HH:MM (DESIGN.md Presentation: times use the app's clock label). */
export function clockLabel(at: number) {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
