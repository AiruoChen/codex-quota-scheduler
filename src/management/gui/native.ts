declare global {
  interface Window { desktopProject?: { chooseDirectory(): Promise<string | null> } }
}
export function canChooseDirectory(): boolean { return typeof window.desktopProject?.chooseDirectory === "function"; }
export async function chooseDirectory(): Promise<string | null> {
  if (!canChooseDirectory()) return null;
  return window.desktopProject!.chooseDirectory();
}
